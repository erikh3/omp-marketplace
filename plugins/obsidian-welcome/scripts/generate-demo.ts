import { mkdir, rm, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";

import { renderWelcomePreview } from "../src/index.ts";

const PLUGIN_ROOT = dirname(import.meta.dir);
const VAULT_PATH = join(PLUGIN_ROOT, "demo-vault");
const OUTPUT_PATH = join(PLUGIN_ROOT, "assets", "welcome.gif");
const FRAME_DIRECTORY = join(PLUGIN_ROOT, ".demo-frames");
const DEMO_NOW = new Date("2026-09-08T21:00:00Z");
const FRAME_COUNT = 46;
const FRAME_DELAY = 7;
const TERMINAL_WIDTH = 112;
const FONT_SIZE = 18;
const CELL_WIDTH = 10.84;
const LINE_HEIGHT = 24;
const PADDING = 18;

const NOTE_AGES_MINUTES: Record<string, number> = {
  "Daily/2026-09-07.md": 1,
  "Daily/2026-09-04.md": 5760,
  "Architecture.md": 3,
  "Project plan.md": 18,
  "Meeting notes.md": 47,
  "Research.md": 135,
  "Inbox.md": 360,
};

const ANSI_COLORS: Record<string, string> = {
  "38;2;128;128;128": "#808080",
  "38;2;167;139;250": "#a78bfa",
  "38;2;8;185;78": "#08b94e",
  "38;2;0;191;188": "#00bfbc",
};

interface Span {
  bold: boolean;
  color: string;
  text: string;
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function ansiSpans(line: string): Span[] {
  const plain = line.replaceAll(/\x1b\]8;;.*?\x1b\\/g, "");
  const spans: Span[] = [];
  let color = "#d8d8df";
  let bold = false;
  let offset = 0;

  for (const match of plain.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const index = match.index ?? 0;
    if (index > offset) spans.push({ bold, color, text: plain.slice(offset, index) });
    const code = match[1];
    if (code === "0" || code === "39") color = "#d8d8df";
    else if (code === "1") bold = true;
    else if (code === "22") bold = false;
    else if (code.startsWith("38;2;")) color = ANSI_COLORS[code] ?? `rgb(${code.slice(5).replaceAll(";", ",")})`;
    else if (code.startsWith("38;5;")) color = "#a78bfa";
    offset = index + match[0].length;
  }
  if (offset < plain.length) spans.push({ bold, color, text: plain.slice(offset) });
  return spans;
}

function renderSvg(lines: readonly string[]): string {
  const width = Math.ceil(Math.max(...lines.map(visibleLength)) * CELL_WIDTH + PADDING * 2);
  const height = lines.length * LINE_HEIGHT + PADDING * 2;
  const text = lines.map((line, row) => {
    const spans = ansiSpans(line)
      .map((span) => `<tspan fill="${span.color}"${span.bold ? ' font-weight="700"' : ""}>${escapeXml(span.text)}</tspan>`)
      .join("");
    return `<text x="${PADDING}" y="${PADDING + (row + 1) * LINE_HEIGHT}" xml:space="preserve">${spans}</text>`;
  }).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" rx="10" fill="#1e1e2e"/>
<g font-family="Menlo, Monaco, monospace" font-size="${FONT_SIZE}px">${text}</g>
</svg>\n`;
}

function visibleLength(line: string): number {
  return line.replaceAll(/\x1b\]8;;.*?\x1b\\/g, "").replaceAll(/\x1b\[[0-9;]*m/g, "").length;
}

async function setFixtureTimes(): Promise<void> {
  for (const [file, minutes] of Object.entries(NOTE_AGES_MINUTES)) {
    const modified = new Date(DEMO_NOW.getTime() - minutes * 60_000);
    await utimes(join(VAULT_PATH, file), modified, modified);
  }
}

async function generate(): Promise<void> {
  await setFixtureTimes();
  await rm(FRAME_DIRECTORY, { recursive: true, force: true });
  await mkdir(FRAME_DIRECTORY, { recursive: true });

  const framePaths: string[] = [];
  for (let index = 0; index < FRAME_COUNT; index++) {
    const progress = Math.min(index / (FRAME_COUNT - 6), 1);
    const lines = await renderWelcomePreview(VAULT_PATH, TERMINAL_WIDTH, progress, DEMO_NOW);
    const svgPath = join(FRAME_DIRECTORY, `${String(index).padStart(3, "0")}.svg`);
    await Bun.write(svgPath, renderSvg(lines));
    framePaths.push(svgPath);
  }

  const magick = Bun.which("magick");
  if (!magick) throw new Error("ImageMagick is required. Install it with: brew install imagemagick");
  const process = Bun.spawn([
    magick,
    "-delay",
    String(FRAME_DELAY),
    "-loop",
    "0",
    ...framePaths,
    "-layers",
    "Optimize",
    OUTPUT_PATH,
  ], { stderr: "inherit", stdout: "inherit" });
  const exitCode = await process.exited;
  await rm(FRAME_DIRECTORY, { recursive: true, force: true });
  if (exitCode !== 0) throw new Error(`ImageMagick exited with code ${exitCode}`);
  console.log(`Generated ${OUTPUT_PATH}`);
}

await generate();
