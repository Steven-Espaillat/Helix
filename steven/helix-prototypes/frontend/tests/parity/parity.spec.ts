import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { compare, encode, sideBySide, type Rect } from "./image";
import {
  BASE_URL,
  DEFAULT_MAX_DIFF_RATIO,
  DEFAULT_PIXEL_THRESHOLD,
  DEFAULT_REFERENCE_FILE,
  INCLUDE_PENDING,
  MUTATE_CSS,
  ONLY,
  OUT_DIR,
  VIEWPORT,
} from "./parity.config";
import { SCREENS } from "./screens";
import type { CaptureSpec, ParityScreen } from "./types";

// Visual parity kit (UI step 0): renders our screen and the reference HTML at
// the same viewport, diffs them with pixelmatch, and writes
// evidence/parity/<screen>/{ours,reference,diff,side-by-side}.png.

const FRONTEND = path.resolve(__dirname, "../..");
const PROTOTYPES = path.resolve(FRONTEND, "..");
const OUT = path.resolve(FRONTEND, OUT_DIR);
const FONT_HOST = "https://helix-parity.local";

type Row = {
  id: string;
  lane: string;
  status: string;
  colorScheme: string;
  ratio: number | null;
  maxDiffRatio: number;
  pass: boolean | null;
  size: string;
  note: string;
};
// Rows are persisted per screen because Playwright restarts the worker after
// a failed test (in-memory state would be lost). global-setup.ts clears them.
const ROWS_DIR = path.join(OUT, ".rows");
function pushRow(row: Row) {
  mkdirSync(ROWS_DIR, { recursive: true });
  writeFileSync(path.join(ROWS_DIR, `${row.id}.json`), JSON.stringify(row));
}
function readRows(): Row[] {
  if (!existsSync(ROWS_DIR)) return [];
  return readdirSync(ROWS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(path.join(ROWS_DIR, name), "utf8")) as Row);
}

// The reference loads IBM Plex from Google Fonts. Serve the same @fontsource
// files our app self-hosts instead, so both sides use identical font bytes and
// the run works offline.
function fontCss(): string {
  const files: Array<[string, string]> = [
    ["ibm-plex-sans", "400"],
    ["ibm-plex-sans", "500"],
    ["ibm-plex-sans", "600"],
    ["ibm-plex-sans", "700"],
    ["ibm-plex-mono", "400"],
    ["ibm-plex-mono", "500"],
  ];
  return files
    .map(([pkg, weight]) =>
      readFileSync(path.join(FRONTEND, "node_modules/@fontsource", pkg, `${weight}.css`), "utf8").replaceAll(
        "url(./files/",
        `url(${FONT_HOST}/${pkg}/files/`,
      ),
    )
    .join("\n");
}

async function routeReferenceFonts(page: Page) {
  const css = fontCss();
  await page.route("https://fonts.googleapis.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/css", body: css }),
  );
  await page.route("https://fonts.gstatic.com/**", (route) => route.abort());
  await page.route(`${FONT_HOST}/**`, (route) => {
    const rel = new URL(route.request().url()).pathname.replace(/^\//, "");
    const [pkg, ...rest] = rel.split("/");
    const file = path.join(FRONTEND, "node_modules/@fontsource", pkg, ...rest);
    return route.fulfill({
      status: 200,
      contentType: file.endsWith(".woff2") ? "font/woff2" : "font/woff",
      body: readFileSync(file),
    });
  });
}

const FREEZE_CSS = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}`;

async function capture(
  browser: Browser,
  url: string,
  spec: CaptureSpec,
  colorScheme: "light" | "dark",
  isReference: boolean,
): Promise<{ png: Buffer; masks: Rect[] }> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    if (isReference) {
      await routeReferenceFonts(page);
    }
    await page.goto(url, { waitUntil: "load" });
    await page.locator(spec.waitFor ?? (spec.selector === "viewport" ? "body" : spec.selector)).first().waitFor();
    await page.addStyleTag({ content: FREEZE_CSS + (spec.css ?? "") + (isReference ? "" : MUTATE_CSS) });
    for (const { selector, text } of spec.replaceText ?? []) {
      await page.locator(selector).evaluateAll((elements, value) => {
        for (const element of elements) element.textContent = value;
      }, text);
    }
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.mouse.move(0, 0);

    let png: Buffer;
    let origin = { x: 0, y: 0 };
    if (spec.selector === "viewport") {
      png = await page.screenshot({ animations: "disabled", caret: "hide" });
    } else {
      const target = page.locator(spec.selector).first();
      png = await target.screenshot({ animations: "disabled", caret: "hide" });
      const box = await target.boundingBox();
      if (!box) throw new Error(`No box for ${spec.selector}`);
      origin = { x: box.x, y: box.y };
    }
    const masks: Rect[] = [];
    for (const selector of spec.mask ?? []) {
      for (const element of await page.locator(selector).all()) {
        const box = await element.boundingBox();
        if (box) masks.push({ x: box.x - origin.x, y: box.y - origin.y, width: box.width, height: box.height });
      }
    }
    return { png, masks };
  } finally {
    await context.close();
  }
}

function referenceUrl(screen: ParityScreen): string {
  const file = path.resolve(PROTOTYPES, screen.referenceFile ?? DEFAULT_REFERENCE_FILE);
  return pathToFileURL(file).href + screen.reference.path;
}

const selected = SCREENS.filter((screen) => ONLY.length === 0 || ONLY.includes(screen.id));

for (const screen of selected) {
  test(`${screen.id} [${screen.status}] lane ${screen.lane}`, async ({ browser }) => {
    const maxDiffRatio = screen.maxDiffRatio ?? DEFAULT_MAX_DIFF_RATIO;
    if (screen.status === "pending" && !INCLUDE_PENDING) {
      pushRow({
        id: screen.id,
        lane: screen.lane,
        status: "pending",
        colorScheme: screen.colorScheme,
        ratio: null,
        maxDiffRatio,
        pass: null,
        size: "",
        note: `skipped: owned by lane ${screen.lane}${screen.issue ? ` (${screen.issue})` : ""}`,
      });
      test.skip(true, `Pending: lane ${screen.lane} ${screen.issue ?? ""} flips this screen to "enforced".`);
      return;
    }

    const ours = await capture(browser, BASE_URL + screen.ours.path, screen.ours, screen.colorScheme, false);
    const ref = await capture(browser, referenceUrl(screen), screen.reference, screen.colorScheme, true);
    const result = compare(ours.png, ref.png, [...ours.masks, ...ref.masks], screen.pixelThreshold ?? DEFAULT_PIXEL_THRESHOLD);

    const dir = path.join(OUT, screen.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "ours.png"), encode(result.ours));
    writeFileSync(path.join(dir, "reference.png"), encode(result.reference));
    writeFileSync(path.join(dir, "diff.png"), encode(result.diff));
    writeFileSync(path.join(dir, "side-by-side.png"), encode(sideBySide([result.ours, result.reference, result.diff])));
    const enforced = screen.status === "enforced";
    const pass = result.ratio <= maxDiffRatio;
    const summary = {
      id: screen.id,
      title: screen.title,
      lane: screen.lane,
      issue: screen.issue ?? null,
      status: screen.status,
      colorScheme: screen.colorScheme,
      viewport: VIEWPORT,
      ours: BASE_URL.replace(/^https?:\/\/[^/]+/, "<base>") + screen.ours.path,
      reference: (screen.referenceFile ?? DEFAULT_REFERENCE_FILE) + screen.reference.path,
      pixelThreshold: screen.pixelThreshold ?? DEFAULT_PIXEL_THRESHOLD,
      maxDiffRatio,
      ratio: Number(result.ratio.toFixed(6)),
      diffPixels: result.diffPixels,
      comparedPixels: result.comparedPixels,
      maskedPixels: result.maskedPixels,
      oursSize: result.oursSize,
      referenceSize: result.referenceSize,
      sizeMismatch: result.sizeMismatch,
      pass,
    };
    writeFileSync(path.join(dir, "result.json"), JSON.stringify(summary, null, 2) + "\n");
    pushRow({
      id: screen.id,
      lane: screen.lane,
      status: screen.status,
      colorScheme: screen.colorScheme,
      ratio: result.ratio,
      maxDiffRatio,
      pass: enforced ? pass : null,
      size: `${result.oursSize.width}x${result.oursSize.height} vs ${result.referenceSize.width}x${result.referenceSize.height}`,
      note: result.sizeMismatch ? "size mismatch (padded area counts as diff)" : "",
    });
    test.info().annotations.push({ type: "parity", description: `ratio=${(result.ratio * 100).toFixed(3)}% max=${(maxDiffRatio * 100).toFixed(2)}%` });

    if (enforced) {
      expect(
        result.ratio,
        `${screen.id}: ${(result.ratio * 100).toFixed(3)}% of pixels differ (max ${(maxDiffRatio * 100).toFixed(2)}%). See ${path.relative(PROTOTYPES, dir)}/side-by-side.png`,
      ).toBeLessThanOrEqual(maxDiffRatio);
    }
  });
}

// Design tokens: every --hx-* custom property declared in the reference
// <style> block must have the same declared value on our side, and every color
// token must resolve to the same color in both themes. This catches token
// drift that covers too little area to move a screen's pixel ratio (for
// example the brand mark, which is under 1% of the header).
const TOKEN_OURS_PATH = "/parity?fixture=upload&stage=0";
const TOKEN_SCOPE = "#helix-e2e";

async function readTokens(page: Page, names: string[]) {
  return page.evaluate(
    ({ names, scope }) => {
      const root = document.querySelector(scope) ?? document.documentElement;
      const style = getComputedStyle(root);
      const probe = document.createElement("span");
      root.appendChild(probe);
      const out: Record<string, { declared: string; resolved: string | null }> = {};
      for (const name of names) {
        // Normalize whitespace, case and quote style (the build rewrites ' to ").
        const declared = style.getPropertyValue(name).trim().replace(/\s+/g, " ").replace(/'/g, '"').toLowerCase();
        probe.style.color = "rgb(1, 2, 3)";
        probe.style.color = `var(${name})`;
        const resolved = getComputedStyle(probe).color;
        const isColor = /^(#|rgb|hsl|light-dark|color-mix)/.test(declared);
        out[name] = { declared, resolved: isColor ? resolved : null };
      }
      probe.remove();
      return out;
    },
    { names, scope: TOKEN_SCOPE },
  );
}

function referenceTokenNames(): string[] {
  const html = readFileSync(path.resolve(PROTOTYPES, DEFAULT_REFERENCE_FILE), "utf8");
  const style = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)?.[1] ?? "";
  return [...new Set([...style.matchAll(/(--hx-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))].sort();
}

if (ONLY.length === 0 || ONLY.includes("design-tokens")) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`design-tokens-${colorScheme} [enforced] lane step0`, async ({ browser }) => {
      const names = referenceTokenNames();
      expect(names.length, "no --hx-* tokens found in the reference").toBeGreaterThan(0);
      const read = async (url: string, isReference: boolean) => {
        const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme });
        const page = await context.newPage();
        try {
          if (isReference) await routeReferenceFonts(page);
          await page.goto(url, { waitUntil: "load" });
          await page.locator(TOKEN_SCOPE).first().waitFor();
          if (!isReference && MUTATE_CSS) await page.addStyleTag({ content: MUTATE_CSS });
          return await readTokens(page, names);
        } finally {
          await context.close();
        }
      };
      const ours = await read(BASE_URL + TOKEN_OURS_PATH, false);
      const ref = await read(pathToFileURL(path.resolve(PROTOTYPES, DEFAULT_REFERENCE_FILE)).href + "?stage=0", true);
      // Color tokens compare by resolved color in this theme: the Next build
      // lowers light-dark() to a per-theme value, so declared text differs
      // while the color is identical. Other tokens compare by declared value.
      const mismatches = names.filter((name) =>
        ref[name].resolved !== null
          ? ours[name].resolved !== ref[name].resolved
          : ours[name].declared !== ref[name].declared,
      );
      const dir = path.join(OUT, `design-tokens-${colorScheme}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "result.json"),
        JSON.stringify({ colorScheme, tokens: names.length, mismatches: mismatches.map((name) => ({ name, ours: ours[name], reference: ref[name] })) }, null, 2) + "\n",
      );
      pushRow({
        id: `design-tokens-${colorScheme}`,
        lane: "step0",
        status: "enforced",
        colorScheme,
        ratio: mismatches.length / names.length,
        maxDiffRatio: 0,
        pass: mismatches.length === 0,
        size: `${names.length} tokens`,
        note: mismatches.length ? `mismatched: ${mismatches.join(", ")}` : "",
      });
      expect(mismatches, `tokens differ from the reference (${colorScheme}); see ${path.relative(PROTOTYPES, dir)}/result.json`).toEqual([]);
    });
  }
}

test.afterAll(() => {
  const rows = readRows();
  if (rows.length === 0) return;
  mkdirSync(OUT, { recursive: true });
  const order = new Map(
    [...selected.map((screen) => screen.id), "design-tokens-light", "design-tokens-dark"].map((id, index) => [id, index]),
  );
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ viewport: VIEWPORT, rows }, null, 2) + "\n");
  const lines = [
    "# Visual parity summary",
    "",
    `Viewport ${VIEWPORT.width}x${VIEWPORT.height} @1x. Default max diff ratio ${(DEFAULT_MAX_DIFF_RATIO * 100).toFixed(2)}%, pixelmatch threshold ${DEFAULT_PIXEL_THRESHOLD}.`,
    "",
    "| Screen | Lane | Status | Theme | Diff ratio | Max | Result | Size (ours vs ref) | Note |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map((row) =>
      [
        row.id,
        row.lane,
        row.status,
        row.colorScheme,
        row.ratio === null ? "-" : `${(row.ratio * 100).toFixed(3)}%`,
        `${(row.maxDiffRatio * 100).toFixed(2)}%`,
        row.pass === null ? (row.ratio === null ? "skipped" : "reported") : row.pass ? "PASS" : "FAIL",
        row.size,
        row.note,
      ].join(" | "),
    ).map((line) => `| ${line} |`),
    "",
  ];
  writeFileSync(path.join(OUT, "summary.md"), lines.join("\n"));
});
