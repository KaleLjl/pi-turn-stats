import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

interface PromptTiming {
	index: number;
	prompt: string;
	promptAt: number;
	targetId?: string;
	models: string[];
	cost: number;
	cumulativeCost: number;
	cumulativeProcessing: number;
	processingDuration?: number;
}

interface TimingSummary {
	rows: PromptTiming[];
	totalCost: number;
	totalProcessing: number;
	completedCount: number;
}

function timestampOf(entry: SessionEntry): number | undefined {
	const value = Date.parse(entry.timestamp);
	return Number.isFinite(value) ? value : undefined;
}

function getUserPrompt(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "user") return undefined;
	const { content } = entry.message;
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function isTerminalActivity(entry: SessionEntry): boolean {
	if (entry.type !== "message") return false;
	return entry.message.role === "assistant" || entry.message.role === "toolResult";
}

function collectTimings(entries: SessionEntry[]): TimingSummary {
	const userPositions: Array<{ position: number; prompt: string; promptAt: number }> = [];

	for (let position = 0; position < entries.length; position++) {
		const entry = entries[position]!;
		const prompt = getUserPrompt(entry);
		const promptAt = timestampOf(entry);
		if (prompt !== undefined && promptAt !== undefined) {
			userPositions.push({ position, prompt, promptAt });
		}
	}

	if (userPositions.length === 0) {
		return { rows: [], totalCost: 0, totalProcessing: 0, completedCount: 0 };
	}
	let totalCost = 0;
	let totalProcessing = 0;
	let completedCount = 0;

	const rows = userPositions.map((current, index): PromptTiming => {
		const nextPosition = userPositions[index + 1]?.position ?? entries.length;
		let stoppedAt: number | undefined;
		let targetId: string | undefined;
		let cost = 0;
		const models = new Set<string>();

		for (let position = current.position + 1; position < nextPosition; position++) {
			const entry = entries[position]!;
			if (entry.type === "message" && entry.message.role === "assistant") {
				const message = entry.message as AssistantMessage;
				models.add(`${message.provider}/${message.responseModel ?? message.model}`);
				cost += message.usage.cost.total;
			}
			if (!isTerminalActivity(entry)) continue;
			const timestamp = timestampOf(entry);
			if (timestamp !== undefined) {
				stoppedAt = timestamp;
				targetId = entry.id;
			}
		}

		totalCost += cost;
		const processingDuration = stoppedAt === undefined ? undefined : Math.max(0, stoppedAt - current.promptAt);
		if (processingDuration !== undefined) {
			totalProcessing += processingDuration;
			completedCount++;
		}

		return {
			index: index + 1,
			prompt: current.prompt.replace(/\s+/g, " ").trim() || "(empty text)",
			promptAt: current.promptAt,
			targetId,
			models: [...models],
			cost,
			cumulativeCost: totalCost,
			cumulativeProcessing: totalProcessing,
			processingDuration,
		};
	});

	return { rows, totalCost, totalProcessing, completedCount };
}

function formatDuration(milliseconds: number | undefined): string {
	if (milliseconds === undefined) return "—";
	let seconds = Math.max(0, Math.round(milliseconds / 1000));
	const days = Math.floor(seconds / 86400);
	seconds %= 86400;
	const hours = Math.floor(seconds / 3600);
	seconds %= 3600;
	const minutes = Math.floor(seconds / 60);
	seconds %= 60;

	const parts: string[] = [];
	if (days) parts.push(`${days}d`);
	if (hours) parts.push(`${hours}h`);
	if (minutes) parts.push(`${minutes}m`);
	if (seconds || parts.length === 0) parts.push(`${seconds}s`);
	return parts.slice(0, 2).join("");
}

function formatCost(cost: number): string {
	if (cost > 0 && cost < 0.0001) return `$${cost.toFixed(6)}`;
	return `$${cost.toFixed(4)}`;
}

function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

class TurnsComponent {
	private scrollTop = 0;
	private selectedIndex: number;
	private cachedWidth?: number;
	private cachedBody: string[] = [];

	constructor(
		private readonly summary: TimingSummary,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly close: (targetId?: string) => void,
	) {
		this.selectedIndex = 0;
		for (const [index, row] of summary.rows.entries()) {
			if (row.targetId) this.selectedIndex = index;
		}
	}

	handleInput(data: string): void {
		const pageSize = Math.max(1, Math.floor(this.bodyHeight() / 4));
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.close();
			return;
		}
		if (matchesKey(data, "enter")) {
			const targetId = this.summary.rows[this.selectedIndex]?.targetId;
			if (targetId) this.close(targetId);
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.select(this.selectedIndex - 1);
		} else if (matchesKey(data, "down") || data === "j") {
			this.select(this.selectedIndex + 1);
		} else if (matchesKey(data, "pageUp")) {
			this.select(this.selectedIndex - pageSize);
		} else if (matchesKey(data, "pageDown") || data === " ") {
			this.select(this.selectedIndex + pageSize);
		} else if (matchesKey(data, "home") || data === "g") {
			this.select(0);
		} else if (matchesKey(data, "end") || data === "G") {
			this.select(this.summary.rows.length - 1);
		}
	}

	render(width: number): string[] {
		if (this.cachedWidth !== width) {
			this.cachedWidth = width;
			this.cachedBody = this.buildBody(width);
		}

		const th = this.theme;
		const bodyHeight = this.bodyHeight();
		const maxScroll = Math.max(0, this.cachedBody.length - bodyHeight);
		this.scrollTop = Math.min(this.scrollTop, maxScroll);
		this.keepSelectedVisible();

		const average = this.summary.completedCount
			? this.summary.totalProcessing / this.summary.completedCount
			: undefined;
		const header = [
			truncateToWidth(th.fg("accent", th.bold("Prompt Timing & Cost Stats")), width),
			truncateToWidth(
				th.fg(
					"muted",
					`${this.summary.rows.length} turns · total cost ${formatCost(this.summary.totalCost)} · total processing ${formatDuration(this.summary.totalProcessing)} · avg ${formatDuration(average)}`,
				),
				width,
			),
			truncateToWidth(th.fg("dim", "Costs are summarized from the session record; cumulative values run up to each turn"), width),
			th.fg("borderMuted", "─".repeat(Math.max(0, width))),
		];

		const visible = this.cachedBody.slice(this.scrollTop, this.scrollTop + bodyHeight);
		const footerText = `↑↓/jk select · PgUp/PgDn page · Enter jump to turn (new branch) · Esc/q close`;
		const footer = [
			th.fg("borderMuted", "─".repeat(Math.max(0, width))),
			truncateToWidth(th.fg("dim", footerText), width),
		];

		return [...header, ...visible, ...footer];
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedBody = [];
	}

	private bodyHeight(): number {
		return Math.max(3, this.tui.terminal.rows - 6);
	}

	private select(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(this.summary.rows.length - 1, index));
		this.cachedWidth = undefined;
		this.tui.requestRender();
	}

	private keepSelectedVisible(): void {
		if (this.summary.rows.length === 0) return;
		const firstLine = this.selectedIndex * 4;
		const lastLine = firstLine + 2;
		if (firstLine < this.scrollTop) this.scrollTop = firstLine;
		if (lastLine >= this.scrollTop + this.bodyHeight()) {
			this.scrollTop = lastLine - this.bodyHeight() + 1;
		}
	}

	private buildBody(width: number): string[] {
		const th = this.theme;
		if (this.summary.rows.length === 0) {
			return ["", truncateToWidth(th.fg("dim", "No user prompts in this branch yet."), width)];
		}

		const lines: string[] = [];
		for (const [index, row] of this.summary.rows.entries()) {
			lines.push(
				truncateToWidth(
					`${index === this.selectedIndex ? th.fg("accent", "❯") : " "} ` +
						`${th.fg("accent", `#${row.index}`)} ${th.fg("dim", formatTime(row.promptAt))}  ` +
						`${th.fg("muted", "model")} ${row.models.join(", ") || "—"}${row.targetId ? "" : " (incomplete, not jumpable)"}`,
					width,
				),
			);
			lines.push(
				truncateToWidth(
					`  ${th.fg("muted", "turn cost")} ${formatCost(row.cost)}  ` +
						`${th.fg("muted", "cumulative cost")} ${formatCost(row.cumulativeCost)}  ` +
						`${th.fg("muted", "turn time")} ${formatDuration(row.processingDuration)}  ` +
						`${th.fg("muted", "cumulative time")} ${formatDuration(row.cumulativeProcessing)}`,
					width,
				),
			);
			lines.push(truncateToWidth(`  ${row.prompt}`, width));
			lines.push("");
		}
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "get_turn_stats",
		label: "Get Turn Stats",
		description:
			"Get the models, costs, and processing durations of completed user turns in the current session branch. Use it when you need statistics on the cost of earlier tasks.",
		promptSnippet: "Get models, costs, and durations of completed turns",
		promptGuidelines: [
			"Use get_turn_stats for accurate model costs and durations of earlier completed tasks; do not use it to estimate the turn that is still running.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const summary = collectTimings(ctx.sessionManager.getBranch());
			// When the tool call runs, the last user turn is still in progress and
			// cannot be included in final statistics.
			const completedRows = summary.rows.slice(0, -1);
			const rows = completedRows.map((row) => ({
				index: row.index,
				prompt: row.prompt.slice(0, 300),
				promptAt: new Date(row.promptAt).toISOString(),
				models: row.models,
				cost: row.cost,
				processingMilliseconds: row.processingDuration,
				processingDuration: formatDuration(row.processingDuration),
			}));
			const totalCost = completedRows.reduce((sum, row) => sum + row.cost, 0);
			const totalProcessingMilliseconds = completedRows.reduce(
				(sum, row) => sum + (row.processingDuration ?? 0),
				0,
			);
			const result = {
				rows,
				totalCost,
				totalProcessingMilliseconds,
				totalProcessingDuration: formatDuration(totalProcessingMilliseconds),
			};

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerCommand("turns", {
		description: "Show models, costs, and timing for every prompt in the current session branch",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/turns is only available in interactive TUI mode", "error");
				return;
			}

			const summary = collectTimings(ctx.sessionManager.getBranch());
			const targetId = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
				return new TurnsComponent(summary, tui, theme, done);
			});
			if (targetId) {
				await ctx.waitForIdle();
				await ctx.navigateTree(targetId, { summarize: false });
			}
		},
	});
}
