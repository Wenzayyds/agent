import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
	CORE_MEMORY_NAMES,
	type CoreMemoryDocument,
	type CoreMemoryName,
	type CoreMemoryWriteResult,
	type ProjectScope,
} from "./contracts.ts";
import { MemoryError } from "./errors.ts";

const CORE_DIRECTORY = join(".pi-enhanced", "memory");
const CORE_FILE_NAMES: Record<CoreMemoryName, string> = {
	project: "project.md",
	architecture: "architecture.md",
	decisions: "decisions.md",
};
const MAX_CORE_MEMORY_BYTES = 64 * 1024;
const VISIBILITY_WARNING = "Core Memory 位于项目目录，可能被 Git 跟踪。请勿保存凭据；是否加入 .gitignore 由用户决定。";
const SECRET_PATTERNS = [
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
	/\bghp_[A-Za-z0-9]{30,}\b/u,
	/\bgithub_pat_[A-Za-z0-9_]{30,}\b/u,
	/\bsk-[A-Za-z0-9_-]{20,}\b/u,
	/\b(?:api[_-]?key|token|secret)\s*[:=]\s*["']?[A-Za-z0-9_./+-]{12,}/iu,
];

interface CoreMemoryFileSystem {
	create(source: string, target: string): void;
	replace(source: string, target: string): void;
}

const DEFAULT_FILE_SYSTEM: CoreMemoryFileSystem = {
	create: linkSync,
	replace: renameSync,
};

export class CoreMemoryStore {
	readonly scope: ProjectScope;
	private readonly fileSystem: CoreMemoryFileSystem;
	private visibilityWarningRequired: boolean | undefined;

	constructor(scope: ProjectScope, fileSystem: CoreMemoryFileSystem = DEFAULT_FILE_SYSTEM) {
		this.scope = scope;
		this.fileSystem = fileSystem;
	}

	get(name: CoreMemoryName): CoreMemoryDocument | null {
		const target = this.resolveTarget(name);
		if (!this.validateExistingDirectoryChain()) return null;
		if (!existsSync(target.absolutePath)) return null;
		this.assertRegularFile(target.absolutePath);
		this.assertWithinProject(realpathSync.native(target.absolutePath));
		const metadata = statSync(target.absolutePath);
		if (metadata.size > MAX_CORE_MEMORY_BYTES) {
			throw new MemoryError("MEMORY_VALIDATION_ERROR", "Core Memory document exceeds the size limit");
		}
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(target.absolutePath));
		} catch (error) {
			throw new MemoryError("MEMORY_VALIDATION_ERROR", "Core Memory document is not valid UTF-8", { cause: error });
		}
		return this.document(name, target.relativePath, content, metadata.mtimeMs);
	}

	create(name: CoreMemoryName, content: string): CoreMemoryWriteResult {
		const target = this.resolveTarget(name);
		if (this.validateExistingDirectoryChain() && existsSync(target.absolutePath)) {
			throw new MemoryError("MEMORY_CONTENT_CONFLICT", "Core Memory document already exists");
		}
		return this.write(name, content, false);
	}

	update(name: CoreMemoryName, content: string): CoreMemoryWriteResult {
		const target = this.resolveTarget(name);
		if (!this.validateExistingDirectoryChain() || !existsSync(target.absolutePath)) {
			throw new MemoryError("MEMORY_NOT_FOUND", "Core Memory document does not exist");
		}
		this.assertRegularFile(target.absolutePath);
		return this.write(name, content, true);
	}

	delete(name: CoreMemoryName): void {
		const target = this.resolveTarget(name);
		if (!this.validateExistingDirectoryChain() || !existsSync(target.absolutePath)) {
			throw new MemoryError("MEMORY_NOT_FOUND", "Core Memory document does not exist");
		}
		this.assertRegularFile(target.absolutePath);
		this.assertWithinProject(realpathSync.native(target.absolutePath));
		unlinkSync(target.absolutePath);
	}

	private write(name: CoreMemoryName, content: string, replacing: boolean): CoreMemoryWriteResult {
		const validated = validateCoreContent(content);
		const target = this.resolveTarget(name);
		const showWarning = this.shouldShowVisibilityWarning();
		this.ensureDirectoryChain();
		if (replacing) {
			if (!existsSync(target.absolutePath)) {
				throw new MemoryError("MEMORY_NOT_FOUND", "Core Memory document disappeared before update");
			}
			this.assertRegularFile(target.absolutePath);
		} else if (existsSync(target.absolutePath)) {
			throw new MemoryError("MEMORY_CONTENT_CONFLICT", "Core Memory document appeared before create");
		}
		this.assertWithinProject(realpathSync.native(join(this.scope.rootPath, CORE_DIRECTORY)));

		const temporary = join(this.scope.rootPath, CORE_DIRECTORY, `.${CORE_FILE_NAMES[name]}.${randomUUID()}.tmp`);
		let descriptor: number | undefined;
		try {
			descriptor = openSync(temporary, "wx", 0o600);
			writeFileSync(descriptor, validated, { encoding: "utf8" });
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			this.assertWithinProject(realpathSync.native(join(this.scope.rootPath, CORE_DIRECTORY)));
			if (lstatSync(temporary).isSymbolicLink()) {
				throw new MemoryError("MEMORY_VALIDATION_ERROR", "Core Memory temporary file is a symbolic link");
			}
			if (replacing) this.fileSystem.replace(temporary, target.absolutePath);
			else {
				this.fileSystem.create(temporary, target.absolutePath);
				unlinkSync(temporary);
			}
			this.assertRegularFile(target.absolutePath);
			this.assertWithinProject(realpathSync.native(target.absolutePath));
		} catch (error) {
			if (descriptor !== undefined) closeSync(descriptor);
			if (existsSync(temporary)) unlinkSync(temporary);
			if (error instanceof MemoryError) throw error;
			throw new MemoryError("MEMORY_STORAGE_ERROR", "Core Memory atomic write failed", { cause: error });
		}

		this.visibilityWarningRequired = false;
		const document = this.get(name);
		if (!document) throw new MemoryError("MEMORY_STORAGE_ERROR", "Core Memory write could not be read back");
		return { document, ...(showWarning ? { visibilityWarning: VISIBILITY_WARNING } : {}) };
	}

	private ensureDirectoryChain(): void {
		this.assertCanonicalProjectRoot();
		for (const directory of [join(this.scope.rootPath, ".pi-enhanced"), join(this.scope.rootPath, CORE_DIRECTORY)]) {
			if (!existsSync(directory)) mkdirSync(directory);
			const metadata = lstatSync(directory);
			if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
				throw new MemoryError("MEMORY_VALIDATION_ERROR", "Core Memory directory is not a real directory");
			}
			this.assertWithinProject(realpathSync.native(directory));
		}
	}

	private validateExistingDirectoryChain(): boolean {
		this.assertCanonicalProjectRoot();
		const directories = [join(this.scope.rootPath, ".pi-enhanced"), join(this.scope.rootPath, CORE_DIRECTORY)];
		for (const directory of directories) {
			if (!existsSync(directory)) return false;
			const metadata = lstatSync(directory);
			if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
				throw new MemoryError("MEMORY_VALIDATION_ERROR", "Core Memory directory is not a real directory");
			}
			this.assertWithinProject(realpathSync.native(directory));
		}
		return true;
	}

	private shouldShowVisibilityWarning(): boolean {
		if (this.visibilityWarningRequired !== undefined) return this.visibilityWarningRequired;
		if (!this.validateExistingDirectoryChain()) {
			this.visibilityWarningRequired = true;
			return true;
		}
		this.visibilityWarningRequired = CORE_MEMORY_NAMES.every(
			(name) => !existsSync(join(this.scope.rootPath, CORE_DIRECTORY, CORE_FILE_NAMES[name])),
		);
		return this.visibilityWarningRequired;
	}

	private resolveTarget(name: CoreMemoryName): { absolutePath: string; relativePath: string } {
		if (!CORE_MEMORY_NAMES.includes(name)) {
			throw new MemoryError("MEMORY_VALIDATION_ERROR", "Unsupported Core Memory document name");
		}
		const relativePath = join(CORE_DIRECTORY, CORE_FILE_NAMES[name]);
		const absolutePath = join(this.scope.rootPath, relativePath);
		this.assertWithinProject(absolutePath);
		return { absolutePath, relativePath: relativePath.replaceAll("\\", "/") };
	}

	private assertCanonicalProjectRoot(): void {
		let actual: string;
		try {
			actual = realpathSync.native(this.scope.rootPath);
		} catch (error) {
			throw new MemoryError("MEMORY_STORAGE_ERROR", "Project root is unavailable", { cause: error });
		}
		if (actual !== this.scope.rootPath) {
			throw new MemoryError("MEMORY_VALIDATION_ERROR", "Project root no longer matches the trusted scope");
		}
	}

	private assertRegularFile(path: string): void {
		const metadata = lstatSync(path);
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			throw new MemoryError("MEMORY_VALIDATION_ERROR", "Core Memory target is not a regular file");
		}
	}

	private assertWithinProject(path: string): void {
		const pathFromRoot = relative(this.scope.rootPath, path);
		if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
			throw new MemoryError("MEMORY_VALIDATION_ERROR", "Core Memory path escapes the current project");
		}
	}

	private document(
		name: CoreMemoryName,
		relativePath: string,
		content: string,
		modifiedAt: number,
	): CoreMemoryDocument {
		return {
			projectId: this.scope.projectId,
			name,
			relativePath,
			content,
			contentHash: createHash("sha256").update(content).digest("hex"),
			modifiedAt,
		};
	}
}

function validateCoreContent(content: string): string {
	if (typeof content !== "string") {
		throw new MemoryError("MEMORY_VALIDATION_ERROR", "Core Memory content must be a string");
	}
	if (Buffer.byteLength(content, "utf8") > MAX_CORE_MEMORY_BYTES) {
		throw new MemoryError("MEMORY_VALIDATION_ERROR", "Core Memory content exceeds the size limit");
	}
	if (content.includes("\0")) {
		throw new MemoryError("MEMORY_VALIDATION_ERROR", "Core Memory content contains an invalid null character");
	}
	if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
		throw new MemoryError(
			"MEMORY_VALIDATION_ERROR",
			"Core Memory content appears to contain a credential or private key",
		);
	}
	return content;
}
