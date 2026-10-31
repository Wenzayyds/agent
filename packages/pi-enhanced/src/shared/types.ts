export const ENHANCED_MODULE_NAMES = ["mcp-policy", "memory", "context", "task-manager"] as const;

export type EnhancedModuleName = (typeof ENHANCED_MODULE_NAMES)[number];

export interface EnhancedModuleConfig {
	enabled: boolean;
}

export interface EnhancedConfig {
	modules: Record<EnhancedModuleName, EnhancedModuleConfig>;
}

export interface LoadedEnhancedConfig {
	config: EnhancedConfig;
	/** Existing configuration files that contributed valid settings, in merge order. */
	sources: string[];
	errors: string[];
}

export interface EnhancedModuleState {
	name: EnhancedModuleName;
	enabled: boolean;
	sources: readonly string[];
	errors: readonly string[];
}
