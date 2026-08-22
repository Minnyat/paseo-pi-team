/**
 * config-schema.mjs — form metadata for every config section the WebUI edits.
 *
 * The UI renders forms from these tables and from nothing else: a field the
 * CLI did not describe cannot appear on screen, so what the browser shows is
 * always reproducible from a terminal. Labels and hints are Vietnamese
 * because the WebUI's audience is; keys, paths and enums stay verbatim.
 *
 * Field shapes (paths are dot-separated; map item paths are relative to the
 * item object):
 *   scalar: { path, type: bool|number|string|enum, label, hint?, default?,
 *             min?, max?, enum? }
 *   lines:  { path, type: "lines" }            one string per textarea line
 *   kv:     { path, type: "kv" }               object of string -> string
 *   map:    { path, type: "map", keyLabel?, addLabel?, fixedKeys?, item? }
 *
 * `seed` is the skeleton a missing file starts from; `presets` are one-click
 * patches the UI offers as buttons. An empty scalar control means "key
 * absent — the default applies", which is why defaults double as placeholders.
 */

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MODEL_CLASSES = ["MONITOR_ECONOMY", "FAST_READ", "CODING_MEDIUM", "REASONING_HIGH", "REVIEW_HIGH"];
const ROLE_PROVIDERS = ["pi-supervisor", "pi-lead", "pi-peer"];

/** Shared shape of one route card inside routing and every cluster host. */
function routeFields() {
	return [
		{
			path: "paseoProvider",
			type: "enum",
			enum: ROLE_PROVIDERS,
			label: "Provider Paseo",
			hint: "Chọn theo vai trò: giám sát / trưởng nhóm / thành viên.",
		},
		{
			path: "model",
			type: "string",
			label: "Mô hình",
			hint: "Dạng <pi-provider>/<model-id>, ví dụ Minnyat/deepseek-v4-flash.",
		},
		{
			path: "thinking",
			type: "enum",
			enum: THINKING_LEVELS,
			label: "Mức suy nghĩ",
			hint: "Phải là mức mô hình hỗ trợ, nếu không sẽ bị ép về mức thấp hơn.",
		},
	];
}

export const CONFIG_SCHEMAS = {
	"pi-settings": {
		label: "Pi — cấu hình chính",
		intro:
			"Hành vi của Pi (trình agent đọc cấu hình này). Ô nào để trống thì dùng giá trị mặc định hiển thị dưới nhãn. Thay đổi có hiệu lực từ phiên agent mới.",
		presets: [
			{
				id: "unstable-provider",
				label: "Chống provider lỗi tạm thời",
				hint: "Thử lại tối đa 6 lần, chờ lâu dần giữa các lần (3s → 6s → 12s → 24s → 48s → 96s) và cắt yêu cầu bị treo sau 10 phút.",
				patch: {
					retry: {
						enabled: true,
						maxRetries: 6,
						baseDelayMs: 3000,
						provider: { timeoutMs: 600000, maxRetries: 0, maxRetryDelayMs: 60000 },
					},
				},
			},
		],
		groups: [
			{
				id: "retry",
				label: "Thử lại khi provider lỗi",
				hint: "Chỉ áp dụng cho lỗi tạm thời (quá tải, giới hạn tốc độ, lỗi 5xx, mất kết nối). Lỗi xác thực hoặc sai yêu cầu không bao giờ được thử lại.",
				fields: [
					{
						path: "retry.enabled",
						type: "bool",
						default: true,
						label: "Tự thử lại khi lỗi tạm thời",
					},
					{
						path: "retry.maxRetries",
						type: "number",
						default: 3,
						min: 0,
						max: 20,
						label: "Số lần thử lại tối đa",
					},
					{
						path: "retry.baseDelayMs",
						type: "number",
						default: 2000,
						min: 0,
						max: 600000,
						label: "Thời gian chờ ban đầu (ms)",
						hint: "Nhân đôi sau mỗi lần thử: để 3000 thì chờ 3s, 6s, 12s…",
					},
					{
						path: "retry.provider.timeoutMs",
						type: "number",
						default: 0,
						min: 0,
						max: 3600000,
						label: "Thời gian chờ mỗi yêu cầu (ms)",
						hint: "0 = để thư viện tự quyết. Đặt 600000 (10 phút) để cắt yêu cầu bị treo rồi thử lại.",
					},
					{
						path: "retry.provider.maxRetries",
						type: "number",
						default: 0,
						min: 0,
						max: 10,
						label: "Số lần thử lại của tầng thư viện",
						hint: "Khuyến cáo giữ 0: đặt lớn hơn có thể che lỗi vượt hạn mức và treo agent rất lâu.",
					},
					{
						path: "retry.provider.maxRetryDelayMs",
						type: "number",
						default: 60000,
						min: 0,
						max: 600000,
						label: "Chờ dài nhất theo yêu cầu của máy chủ (ms)",
						hint: "Nếu máy chủ yêu cầu chờ lâu hơn mức này thì lỗi được trả về ngay thay vì đợi im lặng.",
					},
				],
			},
			{
				id: "model",
				label: "Mô hình & mức suy nghĩ",
				fields: [
					{
						path: "defaultProvider",
						type: "string",
						label: "Nhà cung cấp mặc định",
						hint: "Tên provider như trong ~/.pi/agent/models.json (ví dụ Minnyat).",
					},
					{ path: "defaultModel", type: "string", label: "Mô hình mặc định" },
					{
						path: "defaultThinkingLevel",
						type: "enum",
						enum: THINKING_LEVELS,
						label: "Mức suy nghĩ mặc định",
					},
					{
						path: "hideThinkingBlock",
						type: "bool",
						default: false,
						label: "Ẩn khối suy nghĩ trong kết quả",
					},
				],
			},
			{
				id: "network",
				label: "Mạng & gửi tin",
				fields: [
					{
						path: "transport",
						type: "enum",
						enum: ["auto", "sse", "websocket", "websocket-cached"],
						default: "auto",
						label: "Kiểu truyền với provider",
					},
					{
						path: "httpIdleTimeoutMs",
						type: "number",
						default: 300000,
						min: 0,
						max: 3600000,
						label: "Thời gian im lặng tối đa qua HTTP (ms)",
					},
					{
						path: "websocketConnectTimeoutMs",
						type: "number",
						default: 15000,
						min: 0,
						max: 600000,
						label: "Thời gian kết nối WebSocket (ms)",
					},
					{
						path: "steeringMode",
						type: "enum",
						enum: ["one-at-a-time", "all"],
						default: "one-at-a-time",
						label: "Gửi tin chen ngang",
						hint: "one-at-a-time: lần lượt từng tin; all: dồn hết vào lượt kế tiếp.",
					},
					{
						path: "followUpMode",
						type: "enum",
						enum: ["one-at-a-time", "all"],
						default: "one-at-a-time",
						label: "Gửi tin nối tiếp",
					},
				],
			},
			{
				id: "compaction",
				label: "Nén ngữ cảnh",
				hint: "Khi hội thoại sắp đầy, Pi tóm tắt phần cũ để chạy tiếp thay vì dừng giữa việc.",
				fields: [
					{
						path: "compaction.enabled",
						type: "bool",
						default: true,
						label: "Tự nén khi hội thoại dài",
					},
					{
						path: "compaction.reserveTokens",
						type: "number",
						default: 16384,
						min: 0,
						max: 200000,
						label: "Token dành cho câu trả lời",
					},
					{
						path: "compaction.keepRecentTokens",
						type: "number",
						default: 20000,
						min: 0,
						max: 200000,
						label: "Token gần đây được giữ nguyên (không tóm tắt)",
					},
				],
			},
			{
				id: "ui",
				label: "Giao diện",
				fields: [
					{ path: "theme", type: "string", default: "dark", label: "Giao diện (theme)" },
					{
						path: "defaultProjectTrust",
						type: "enum",
						enum: ["ask", "always", "never"],
						default: "ask",
						label: "Tin thư mục dự án mặc định",
						hint: "ask: hỏi khi chạy tương tác. Chạy tự động (kể cả agent) dùng luôn giá trị này.",
					},
					{ path: "quietStartup", type: "bool", default: false, label: "Ẩn lời chào khi khởi động" },
				],
			},
		],
	},

	paseo: {
		label: "Paseo — daemon & nhà cung cấp",
		intro:
			"Cấu hình của daemon Paseo và các hob provider (supervisor / lead / peer). Sửa xong nên khởi động lại daemon để chắc chắn áp dụng.",
		seed: { version: 1 },
		groups: [
			{
				id: "daemon",
				label: "Daemon",
				fields: [
					{
						path: "daemon.mcp.enabled",
						type: "bool",
						default: true,
						label: "Bật máy chủ MCP của daemon",
					},
					{
						path: "daemon.mcp.injectIntoAgents",
						type: "bool",
						default: true,
						label: "Cấp công cụ MCP cho agent",
					},
				],
			},
			{
				id: "providers",
				label: "Nhà cung cấp (hob provider)",
				fields: [
					{
						path: "agents.providers",
						type: "map",
						keyLabel: "Tên provider",
						addLabel: "Thêm provider",
						item: {
							fields: [
								{ path: "label", type: "string", label: "Tên hiển thị" },
								{
									path: "extends",
									type: "string",
									default: "pi",
									label: "Kế thừa",
									hint: "Thường là pi — hob chạy trên trình agent Pi.",
								},
								{
									path: "env",
									type: "kv",
									label: "Biến môi trường",
									hint: "Ví dụ PASEO_PI_ROLE = supervisor.",
								},
							],
						},
					},
				],
			},
		],
	},

	mcp: {
		label: "Pi — công cụ MCP",
		intro: "Các công cụ MCP mà Pi được phép dùng. Thêm một mục tương đương thêm một máy chủ MCP vào ~/.pi/agent/mcp.json.",
		seed: { mcpServers: {} },
		groups: [
			{
				id: "servers",
				label: "Máy chủ MCP",
				fields: [
					{
						path: "mcpServers",
						type: "map",
						keyLabel: "Tên công cụ",
						addLabel: "Thêm công cụ",
						item: {
							seed: { lifecycle: "lazy" },
							fields: [
								{ path: "command", type: "string", label: "Lệnh chạy" },
								{
									path: "args",
									type: "lines",
									label: "Tham số lệnh",
									hint: "Mỗi dòng một tham số, theo đúng thứ tự.",
								},
								{ path: "env", type: "kv", label: "Biến môi trường" },
								{
									path: "lifecycle",
									type: "string",
									default: "lazy",
									label: "Kiểu khởi động",
									hint: "lazy: chỉ khởi động khi agent dùng tới. Đang dùng phổ biến nhất là lazy.",
								},
							],
						},
					},
				],
			},
		],
	},

	routing: {
		label: "Định tuyến mô hình",
		intro:
			"Chọn mô hình cho từng lớp việc trên máy này. Lấy tên mô hình chính xác bằng lệnh: paseo provider models pi-peer --json",
		seed: { version: 1, routes: {} },
		groups: [
			{
				id: "host",
				label: "Máy này",
				fields: [{ path: "hostId", type: "string", label: "Mã máy (hostId)" }],
			},
			{
				id: "routes",
				label: "Lớp việc → mô hình",
				hint: "Năm lớp việc cố định; điền đủ để agent không phải đoán khi nhận việc.",
				fields: [
					{
						path: "routes",
						type: "map",
						keyLabel: "Lớp việc",
						fixedKeys: MODEL_CLASSES,
						item: { fields: routeFields() },
					},
				],
			},
		],
	},

	cluster: {
		label: "Nhiều máy (cluster)",
		intro:
			"Mỗi máy một thẻ: kết nối, khả năng, giới hạn song song và định tuyến mô hình. Giá trị endpoint chỉ chứa TÊN biến môi trường — không ghi giá trị thật vào file này.",
		seed: { version: 1, hosts: {} },
		groups: [
			{
				id: "hosts",
				label: "Máy trong cụm",
				fields: [
					{
						path: "hosts",
						type: "map",
						keyLabel: "Tên máy",
						addLabel: "Thêm máy",
						item: {
							seed: { connection: { type: "local" }, required: true, capabilities: [], limits: { writers: 0, readers: 2 }, routes: {} },
							fields: [
								{
									path: "connection.type",
									type: "enum",
									enum: ["local", "remote"],
									default: "local",
									label: "Kiểu kết nối",
								},
								{
									path: "connection.endpointEnv",
									type: "string",
									label: "Biến môi trường chứa endpoint",
									hint: "Chỉ tên biến (ví dụ PASEO_MAC_REVIEW); giá trị nằm trong môi trường của máy điều khiển.",
									showIf: { path: "connection.type", equals: "remote" },
								},
								{
									path: "required",
									type: "bool",
									default: true,
									label: "Máy bắt buộc",
									hint: "Nếu bắt buộc mà máy vắng mặt thì cụm không chạy.",
								},
								{
									path: "capabilities",
									type: "lines",
									label: "Khả năng",
									hint: "Mỗi dòng một khả năng: git-read, git-write, focused-test, docker, integration-test, independent-review…",
								},
								{
									path: "limits.writers",
									type: "number",
									default: 0,
									min: 0,
									max: 16,
									label: "Số agent được ghi file cùng lúc",
								},
								{
									path: "limits.readers",
									type: "number",
									default: 2,
									min: 0,
									max: 32,
									label: "Số agent chỉ đọc cùng lúc",
								},
								{
									path: "routes",
									type: "map",
									keyLabel: "Lớp việc",
									fixedKeys: MODEL_CLASSES,
									item: { fields: routeFields() },
								},
							],
						},
					},
				],
			},
		],
	},
};

/** Sections sharing one file share one schema: `providers` and `paseo`. */
export function schemaForSection(section) {
	if (section === "providers" || section === "paseo") return CONFIG_SCHEMAS.paseo;
	return CONFIG_SCHEMAS[section] ?? null;
}
