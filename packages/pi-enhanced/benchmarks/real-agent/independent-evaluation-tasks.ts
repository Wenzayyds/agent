import type { Task } from "./agent-evaluation.ts";

const checks = (contract: string, regression: string) =>
	`from app import evaluate\n\ndef test_contract():\n    assert ${contract}\n\ndef test_regression():\n    assert ${regression}\n`;

export const independentTasks: readonly Task[] = [
	{
		id: "page-buckets",
		category: "单文件边界",
		request:
			"Return the number of pages needed to store the supplied item count, rounding partial pages up. An empty collection needs zero pages.",
		files: { "app.py": "def evaluate(items, size=8):\n    return items // size\n" },
		publicCheck: "evaluate(9) == 2",
		edits: [{ path: "app.py", oldText: "items // size", newText: "(items + size - 1) // size" }],
		hidden: checks("evaluate(25, 8) == 4 and evaluate(3, 2) == 2", "evaluate(0) == 0 and evaluate(16) == 2"),
	},
	{
		id: "meter-adapter",
		category: "多文件接口兼容",
		request:
			"Expose as_meters instead of to_meters in converter.py and migrate the app caller. Preserve the conversion and support fractional values.",
		files: {
			"app.py": "from converter import to_meters\n\ndef evaluate(cm):\n    return to_meters(cm)\n",
			"converter.py": "def to_meters(cm):\n    return cm / 100\n",
		},
		publicCheck: "evaluate(250) == 2.5",
		edits: [
			{ path: "converter.py", oldText: "def to_meters(", newText: "def as_meters(" },
			{ path: "app.py", oldText: "from converter import to_meters", newText: "from converter import as_meters" },
			{ path: "app.py", oldText: "return to_meters(cm)", newText: "return as_meters(cm)" },
		],
		hidden: checks(
			"__import__('converter').as_meters(175) == evaluate(175) == 1.75",
			"evaluate(0) == 0 and evaluate(-25) == -0.25",
		),
	},
	{
		id: "cache-retention",
		category: "Memory 项目规则",
		request:
			"Align the cache retention default with the verified project convention. Preserve explicitly supplied values including zero.",
		files: { "app.py": "def evaluate(hours=None):\n    return 12 if hours is None else hours\n" },
		publicCheck: "evaluate(0) == 0",
		memory: {
			query: "cache retention convention",
			marker: "CACHE_KEEP_36",
			body: "The cache retention convention CACHE_KEEP_36 sets the default to 36 hours.",
		},
		edits: [{ path: "app.py", oldText: "return 12 if", newText: "return 36 if" }],
		hidden: checks("evaluate() == 36 and evaluate(None) == 36", "evaluate(0) == 0 and evaluate(5) == 5"),
	},
	{
		id: "manifest-envelope",
		category: "RAG 文档契约",
		request:
			"Bring the manifest envelope key into compliance with the current partner manifest contract. Keep the supplied value unchanged.",
		files: { "app.py": "def evaluate(reference):\n    return {'reference': reference}\n" },
		publicCheck: "list(evaluate('abc').values()) == ['abc']",
		doc: {
			query: "manifest_ref envelope contract",
			marker: "manifest_ref",
			body: "The current partner manifest envelope uses manifest_ref for the original reference.",
		},
		edits: [{ path: "app.py", oldText: "'reference': reference", newText: "'manifest_ref': reference" }],
		hidden: checks("evaluate('M-24') == {'manifest_ref': 'M-24'}", "list(evaluate('').values()) == ['']"),
	},
	{
		id: "dispatch-routing",
		category: "联合来源",
		request:
			"Align the dispatch output identifier with the partner transport contract and the default route with the verified project dispatch rule.",
		files: {
			"app.py":
				"def evaluate(ticket, route=None):\n    return {'ticket': ticket, 'route': 'normal' if route is None else route}\n",
		},
		publicCheck: "evaluate(8, 'bulk')['route'] == 'bulk'",
		memory: {
			query: "dispatch route rule",
			marker: "DISPATCH_EXPRESS",
			body: "The verified dispatch route rule DISPATCH_EXPRESS uses the express route when none is supplied.",
		},
		doc: {
			query: "dispatch trace_ref transport",
			marker: "trace_ref",
			body: "The partner dispatch transport identifies the supplied ticket with the trace_ref key.",
		},
		edits: [
			{
				path: "app.py",
				oldText: "'ticket': ticket, 'route': 'normal'",
				newText: "'trace_ref': ticket, 'route': 'express'",
			},
		],
		hidden: checks(
			"evaluate(101) == {'trace_ref': 101, 'route': 'express'}",
			"evaluate(0, '')['route'] == '' and 0 in evaluate(0).values()",
		),
	},
	{
		id: "numeric-locale",
		category: "中英跨语言",
		request:
			"Apply the default decimal_separator from the Chinese format contract while preserving any explicit separator.",
		files: { "app.py": "def evaluate(separator=None):\n    return '.' if separator is None else separator\n" },
		publicCheck: "evaluate(';') == ';'",
		doc: {
			query: "decimal_separator default 格式",
			marker: "COMMA_SEPARATOR",
			body: "格式契约 COMMA_SEPARATOR 指定 decimal_separator 缺省时采用逗号（,），显式输入保持原样。",
		},
		edits: [{ path: "app.py", oldText: "return '.' if", newText: "return ',' if" }],
		hidden: checks("evaluate() == ',' and evaluate(None) == ','", "evaluate(':') == ':' and evaluate('') == ''"),
	},
	{
		id: "record-revision",
		category: "文档版本变化",
		request:
			"Migrate the record status field to the current catalog record contract. Preserve the boolean value and do not follow the retired schema.",
		files: { "app.py": "def evaluate(enabled):\n    return {'legacy_enabled': enabled}\n" },
		publicCheck: "list(evaluate(True).values()) == [True]",
		doc: {
			query: "catalog is_active record",
			marker: "is_active",
			body: "The current catalog record writes the boolean unchanged in its is_active field.",
		},
		retired: "The retired record used legacy_enabled. REVOKED_DELIVERY_289 is archived policy text.",
		edits: [{ path: "app.py", oldText: "'legacy_enabled'", newText: "'is_active'" }],
		hidden: checks("evaluate(False) == {'is_active': False}", "list(evaluate(True).values()) == [True]"),
	},
	{
		id: "stable-recovery",
		category: "失败测试后恢复",
		request:
			"Return the first occurrence of each nonempty label, preserving order. Reproduce the failing check before resuming the repair.",
		files: { "app.py": "def evaluate(labels):\n    return sorted(set(labels))\n" },
		publicCheck: "evaluate(['z', '', 'a', 'z']) == ['z', 'a']",
		edits: [
			{
				path: "app.py",
				oldText: "sorted(set(labels))",
				newText: "list(dict.fromkeys(label for label in labels if label))",
			},
		],
		hidden: checks(
			"evaluate(['b', 'a', '', 'c', 'a']) == ['b', 'a', 'c']",
			"evaluate([]) == [] and evaluate(['', '']) == []",
		),
		resume: true,
	},
	{
		id: "quiet-hours",
		category: "无答案",
		request:
			"Find the Saturday quiet-hours start time in the office operations note. If the approved note does not specify it, report missing evidence and leave the code unchanged.",
		files: { "app.py": "def evaluate(label='Saturday'):\n    return label.lower()\n" },
		publicCheck: "evaluate('Monday') == 'monday'",
		referenceOnly: {
			query: "office operations Saturday quiet hours",
			marker: "OPS_NOTE_CURRENT",
			body: "Office operations OPS_NOTE_CURRENT explains the visitor check-in procedure. It lists no quiet-hours schedule.",
		},
		edits: [],
		hidden: checks("evaluate() == 'saturday'", "evaluate('TuEsDaY') == 'tuesday'"),
		abstain: true,
	},
];
