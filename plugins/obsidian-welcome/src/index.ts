import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Component } from "@oh-my-pi/pi-tui";
import { TERMINAL, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { $which, VERSION } from "@oh-my-pi/pi-utils";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const RESET = "\x1b[0m";
const DIM = "\x1b[38;2;128;128;128m";
const ACCENT = "\x1b[38;2;167;139;250m";
const SUCCESS = "\x1b[38;2;8;185;78m";
const NOTE_PATH = "\x1b[38;2;0;191;188m";

const OBSIDIAN_LOGO = [
  "       ▗▄▟██",
  "     ▄█████▛ █▄",
  "    ▐█████▛ ▟███",
  "    ▐████▛ ▟████▌",
  "   ▗ ▜███▎▐█████▌",
  "  ▗█▙ ▜██▎▐██████",
  " ▗███▙ ▜█▙ ▜█████▙",
  "▗█████▙ ▄▄▄▄▃▔▀███▙",
  "▝██████ ██████▄ ▜█▘",
  " ▀████▛ ███████▙ ▘",
  "   ▀█▛ ▟████████▌",
  "      ▝▀▀▀▀████▀",
];

const GRADIENT_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [83, 50, 145],
  [126, 84, 220],
  [167, 139, 250],
  [205, 187, 255],
];
const GRADIENT_RAMP_256 = [54, 91, 98, 135, 141, 183];
const SHINE_HALF_WIDTH = 0.18;
const INTRO_MS = 3000;
const INTRO_TICK_MS = 33;
const INTRO_SWEEPS = 2.5;
const INTRO_SHINE_TRAVERSALS = 3;

interface ShineConfig {
  strength: number;
  pos: number;
}

interface DailyDay {
  label: string;
  exists: boolean;
  isToday: boolean;
  date: string;
}

interface RecentEdit {
  editedAgo: string;
  name: string;
  relativePath: string;
}

interface VaultInfo {
  dailyStatus: DailyDay[];
  recentEdits: RecentEdit[];
  today: string;
}

interface Vault {
  location: string;
  name: string;
  path: string;
}

function containsPath(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== ".." && !isAbsolute(pathFromParent));
}

async function findVaultWithCli(startDirectory: string): Promise<Vault | undefined> {
  const executable = $which("obsidian");
  if (!executable) return undefined;

  const process = Bun.spawn([executable, "vault", "info=path"], {
    cwd: startDirectory,
    stdout: "pipe",
    stderr: "ignore",
  });
  const timeout = setTimeout(() => process.kill(), 1000);
  try {
    const [output, exitCode] = await Promise.all([new Response(process.stdout).text(), process.exited]);
    const vaultPath = resolve(output.trim());
    if (exitCode !== 0 || !existsSync(join(vaultPath, ".obsidian")) || !containsPath(vaultPath, startDirectory)) {
      return undefined;
    }
    return { location: relative(vaultPath, startDirectory), name: basename(vaultPath), path: vaultPath };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function findVaultFromDirectory(startDirectory: string): Vault | undefined {
  let directory = resolve(startDirectory);
  const root = parse(directory).root;

  while (true) {
    if (existsSync(join(directory, ".obsidian"))) {
      return { location: relative(directory, startDirectory), name: basename(directory), path: directory };
    }
    if (directory === root) return undefined;
    directory = dirname(directory);
  }
}

async function findVault(startDirectory: string): Promise<Vault | undefined> {
  return await findVaultWithCli(startDirectory) ?? findVaultFromDirectory(startDirectory);
}

function formatTimeAgo(modifiedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - modifiedAt) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function dim(text: string): string {
  return `${DIM}${text}${RESET}`;
}

function accent(text: string): string {
  return `${ACCENT}${text}${RESET}`;
}

function success(text: string): string {
  return `${SUCCESS}${text}${RESET}`;
}

function notePath(text: string): string {
  return `${NOTE_PATH}${text}${RESET}`;
}

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[22m`;
}

function center(text: string, width: number): string {
  const contentWidth = visibleWidth(text);
  if (contentWidth >= width) return truncateToWidth(text, width);
  const left = Math.floor((width - contentWidth) / 2);
  return `${" ".repeat(left)}${text}${" ".repeat(width - contentWidth - left)}`;
}

function fit(text: string, width: number): string {
  const contentWidth = visibleWidth(text);
  return contentWidth > width
    ? truncateToWidth(text, width)
    : `${text}${" ".repeat(width - contentWidth)}`;
}

function obLink(text: string, vaultName: string, file: string): string {
  const url = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}&paneType=tab`;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function gradientEscape(position: number, shine?: ShineConfig): string {
  const shineStrength = shine && shine.strength > 0 ? shine.strength : 0;
  if (TERMINAL.trueColor) {
    const segment = position * (GRADIENT_STOPS.length - 1);
    const index = Math.min(GRADIENT_STOPS.length - 2, Math.floor(segment));
    const fraction = segment - index;
    const start = GRADIENT_STOPS[index];
    const end = GRADIENT_STOPS[index + 1];
    let red = start[0] + (end[0] - start[0]) * fraction;
    let green = start[1] + (end[1] - start[1]) * fraction;
    let blue = start[2] + (end[2] - start[2]) * fraction;

    if (shineStrength > 0) {
      const intensity = Math.max(0, 1 - Math.abs(position - (shine?.pos ?? 0)) / SHINE_HALF_WIDTH) * shineStrength;
      red += (255 - red) * intensity;
      green += (255 - green) * intensity;
      blue += (255 - blue) * intensity;
    }
    return `\x1b[38;2;${Math.round(red)};${Math.round(green)};${Math.round(blue)}m`;
  }

  let index = Math.min(GRADIENT_RAMP_256.length - 1, Math.round(position * (GRADIENT_RAMP_256.length - 1)));
  if (shineStrength > 0) {
    const intensity = Math.max(0, 1 - Math.abs(position - (shine?.pos ?? 0)) / SHINE_HALF_WIDTH) * shineStrength;
    if (intensity > 0.5) index = GRADIENT_RAMP_256.length - 1;
  }
  return `\x1b[38;5;${GRADIENT_RAMP_256[index]}m`;
}

function gradientLogo(phase = 0, shine?: ShineConfig): string[] {
  const rows = OBSIDIAN_LOGO.length;
  const columns = Math.max(...OBSIDIAN_LOGO.map((line) => line.length));
  const span = Math.max(1, columns + rows - 1);
  return OBSIDIAN_LOGO.map((line, row) => {
    const paddedLine = line.padEnd(columns);
    let result = "";
    for (let column = 0; column < paddedLine.length; column++) {
      const character = paddedLine[column];
      if (character === " ") {
        result += character;
        continue;
      }
      const base = (column + (rows - 1 - row)) / span;
      const position = (((base + phase) % 1) + 1) % 1;
      result += `${gradientEscape(position, shine)}${character}${RESET}`;
    }
    return result;
  });
}

function introLogoFrame(progress: number): string[] {
  const eased = 1 - (1 - progress) ** 3;
  const phase = ((((1 - eased) * INTRO_SWEEPS) % 1) + 1) % 1;
  const shinePos = (((progress * INTRO_SHINE_TRAVERSALS) % 1) + 1) % 1;
  return gradientLogo(phase, { strength: (1 - eased) ** 1.5, pos: shinePos });
}

function dailyStatus(vaultPath: string): DailyDay[] {
  const days: DailyDay[] = [];
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const now = new Date();

  for (let offset = 6; offset >= 0; offset--) {
    const day = new Date(now);
    day.setDate(now.getDate() - offset);
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    days.push({
      label: weekdays[day.getDay()],
      exists: existsSync(join(vaultPath, "Daily", `${date}.md`)),
      isToday: offset === 0,
      date,
    });
  }

  return days;
}

async function recentEdits(vaultPath: string, limit = 5): Promise<RecentEdit[]> {
  const edits: Array<RecentEdit & { modifiedAt: number }> = [];

  async function scan(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      if (entry.name.startsWith(".")) return;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (relative(vaultPath, absolutePath) === "Private") return;
        await scan(absolutePath);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) return;

      try {
        const modified = await stat(absolutePath);
        edits.push({
          editedAgo: formatTimeAgo(modified.mtimeMs),
          modifiedAt: modified.mtimeMs,
          name: basename(entry.name, ".md"),
          relativePath: relative(vaultPath, absolutePath).slice(0, -3),
        });
      } catch {
        return;
      }
    }));
  }

  await scan(vaultPath);
  return edits
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, limit)
    .map(({ editedAgo, name, relativePath }) => ({ editedAgo, name, relativePath }));
}

async function vaultInfo(vaultPath: string): Promise<VaultInfo> {
  const now = new Date();
  return {
    dailyStatus: dailyStatus(vaultPath),
    recentEdits: await recentEdits(vaultPath),
    today: `${String(now.getDate()).padStart(2, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${now.getFullYear()}`,
  };
}

function leftColumn(model: string, provider: string, width: number, logo: readonly string[]): string[] {
  const logoWidth = Math.max(...OBSIDIAN_LOGO.map(visibleWidth));
  return [
    "",
    center(bold("Welcome back!"), width),
    "",
    ...logo.map((line) => center(line.padEnd(logoWidth), width)),
    "",
    center(accent(model), width),
    center(dim(provider), width),
  ];
}

function vaultLines(vault: VaultInfo, vaultName: string, width: number): string[] {
  const previous = vault.dailyStatus.filter((day) => !day.isToday);
  const today = vault.dailyStatus.find((day) => day.isToday);
  const markerCell = (day: DailyDay) =>
    day.exists
      ? ` ${obLink(success("▣"), vaultName, `Daily/${day.date}`)} `
      : ` ${dim("☐")} `;
  const labels = previous.map((day) => dim(day.label)).join(" ");
  const markers = previous.map(markerCell).join(" ");
  const todayLabel = today
    ? ` ${dim("│")} ${dim(today.label)} ${dim("(today)")}`
    : "";
  const todayMarker = today ? `  ${dim("│")}${markerCell(today)}` : "";
  const prefix = " - Dailies  ";
  const lines = [
    `${" ".repeat(prefix.length)}${labels}${todayLabel}`,
    `${dim("- ")}Dailies  ${markers}${todayMarker}${dim(vault.today)}`,
  ];

  if (vault.recentEdits.length > 0) {
    lines.push("");
    lines.push(` ${bold(accent("Recent edits"))}`);
    for (const note of vault.recentEdits) {
      const suffix = ` ${dim(`· ${note.editedAgo}`)}`;
      const maxLabelWidth = Math.max(1, width - 3 - visibleWidth(suffix));
      const label = truncateToWidth(note.name, maxLabelWidth);
      lines.push(` ${dim("• ")}${obLink(notePath(label), vaultName, note.relativePath)}${suffix}`);
    }
  }

  return lines;
}

function rightColumn(vault: VaultInfo, detectedVault: Vault, width: number): string[] {
  const separator = ` ${dim("─".repeat(width - 2))}`;
  const location = detectedVault.location ? ` ${dim(`· ${detectedVault.location}`)}` : "";
  return [
    ` ${bold(accent("Tips"))}`,
    ` ${dim("#")} for prompt actions`,
    ` ${dim("/")} for commands`,
    ` ${dim("!")} to run bash`,
    ` ${dim("$")} to run python`,
    separator,
    ` ${bold(accent("Vault"))} ${dim(detectedVault.name)}${location}`,
    ...vaultLines(vault, detectedVault.name, width),
  ];
}

class ObsidianWelcome implements Component {
  #animationStart: number | null = null;
  #animationTimer: Timer | null = null;

  constructor(
    private readonly model: string,
    private readonly provider: string,
    private readonly detectedVault: Vault,
    private readonly vault: VaultInfo,
  ) {}

  playIntro(requestRender: () => void): void {
    this.dispose();
    this.#animationStart = performance.now();
    requestRender();
    this.#animationTimer = setInterval(() => {
      const elapsed = performance.now() - (this.#animationStart ?? 0);
      if (elapsed >= INTRO_MS) this.dispose();
      requestRender();
    }, INTRO_TICK_MS);
    this.#animationTimer.unref?.();
  }

  dispose(): void {
    if (this.#animationTimer !== null) {
      clearInterval(this.#animationTimer);
      this.#animationTimer = null;
    }
    this.#animationStart = null;
  }

  render(terminalWidth: number): readonly string[] {
    if (terminalWidth < 44) return [];
    const boxWidth = Math.max(76, terminalWidth - 2);
    const leftWidth = 26;
    const rightWidth = boxWidth - leftWidth - 3;
    const elapsed = this.#animationStart === null ? INTRO_MS : performance.now() - this.#animationStart;
    const logo = elapsed < INTRO_MS ? introLogoFrame(elapsed / INTRO_MS) : gradientLogo();
    const left = leftColumn(this.model, this.provider, leftWidth, logo);
    const right = rightColumn(this.vault, this.detectedVault, rightWidth);
    const border = dim("│");
    const lines = [
      `${dim(`╭─── omp v${VERSION} `)}${dim("─".repeat(boxWidth - visibleWidth(` omp v${VERSION} `) - 5))}╮`,
    ];

    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      lines.push(`${border}${fit(left[index] ?? "", leftWidth)}${border}${fit(right[index] ?? "", rightWidth)}${border}`);
    }

    lines.push(`${dim("╰")}${dim("─".repeat(leftWidth))}${dim("┴")}${dim("─".repeat(rightWidth))}${dim("╯")}`);
    lines.push("");
    return lines;
  }
}

export default function obsidianWelcome(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const obsidianVault = await findVault(ctx.cwd);
    if (!obsidianVault) return;

    const model = ctx.model?.name ?? ctx.model?.id ?? "No model";
    const provider = ctx.model?.provider ?? "Unknown";
    const info = await vaultInfo(obsidianVault.path);

    ctx.setTimeout(() => {
      ctx.ui.setWidget(
        "obsidian-welcome",
        (tui) => {
          const welcome = new ObsidianWelcome(model, provider, obsidianVault, info);
          welcome.playIntro(() => tui.requestComponentRender(welcome));
          return welcome;
        },
        { placement: "aboveEditor" },
      );
    }, 100);
  });

  pi.on("input", async (_event, ctx) => {
    ctx.ui.setWidget("obsidian-welcome", undefined);
  });
}
