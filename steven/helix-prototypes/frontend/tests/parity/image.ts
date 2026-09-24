import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

// Pixel comparison and side-by-side composition for the parity kit.

export type Rect = { x: number; y: number; width: number; height: number };

// Size-mismatch padding: a color that never appears in the design, so padded
// pixels always count as different (a height mismatch is a real layout diff).
const PAD: [number, number, number] = [255, 0, 255];
// Masked regions are painted with the same neutral on both images.
const MASK: [number, number, number] = [128, 128, 128];
const GAP_COLOR: [number, number, number] = [192, 196, 200];

export type CompareResult = {
  width: number;
  height: number;
  oursSize: { width: number; height: number };
  referenceSize: { width: number; height: number };
  sizeMismatch: boolean;
  diffPixels: number;
  comparedPixels: number;
  maskedPixels: number;
  ratio: number;
  diff: PNG;
  ours: PNG;
  reference: PNG;
};

function pad(source: PNG, width: number, height: number): PNG {
  const out = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    out.data[i * 4] = PAD[0];
    out.data[i * 4 + 1] = PAD[1];
    out.data[i * 4 + 2] = PAD[2];
    out.data[i * 4 + 3] = 255;
  }
  PNG.bitblt(source, out, 0, 0, source.width, source.height, 0, 0);
  return out;
}

function maskGrid(width: number, height: number, rects: Rect[]): Uint8Array {
  const grid = new Uint8Array(width * height);
  for (const rect of rects) {
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
    for (let y = y0; y < y1; y += 1) {
      grid.fill(1, y * width + x0, y * width + x1);
    }
  }
  return grid;
}

function paint(png: PNG, grid: Uint8Array) {
  for (let i = 0; i < grid.length; i += 1) {
    if (grid[i]) {
      png.data[i * 4] = MASK[0];
      png.data[i * 4 + 1] = MASK[1];
      png.data[i * 4 + 2] = MASK[2];
      png.data[i * 4 + 3] = 255;
    }
  }
}

export function compare(oursBuf: Buffer, referenceBuf: Buffer, masks: Rect[], pixelThreshold: number): CompareResult {
  const oursRaw = PNG.sync.read(oursBuf);
  const refRaw = PNG.sync.read(referenceBuf);
  const width = Math.max(oursRaw.width, refRaw.width);
  const height = Math.max(oursRaw.height, refRaw.height);
  const ours = pad(oursRaw, width, height);
  const reference = pad(refRaw, width, height);
  const grid = maskGrid(width, height, masks);
  paint(ours, grid);
  paint(reference, grid);
  const maskedPixels = grid.reduce((sum, value) => sum + value, 0);
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(ours.data, reference.data, diff.data, width, height, {
    threshold: pixelThreshold,
    includeAA: false,
    alpha: 0.25,
    diffColor: [220, 0, 0],
    aaColor: [255, 200, 0],
  });
  const comparedPixels = width * height - maskedPixels;
  return {
    width,
    height,
    oursSize: { width: oursRaw.width, height: oursRaw.height },
    referenceSize: { width: refRaw.width, height: refRaw.height },
    sizeMismatch: oursRaw.width !== refRaw.width || oursRaw.height !== refRaw.height,
    diffPixels,
    comparedPixels,
    maskedPixels,
    ratio: comparedPixels > 0 ? diffPixels / comparedPixels : 0,
    diff,
    ours,
    reference,
  };
}

/**
 * ours | reference | diff. Wide captures (> 900px) stack top to bottom so the
 * image stays readable; narrow ones sit left to right.
 */
export function sideBySide(images: PNG[], gap = 12): PNG {
  const vertical = images[0].width > 900;
  const width = vertical ? Math.max(...images.map((i) => i.width)) : images.reduce((s, i) => s + i.width, 0) + gap * (images.length - 1);
  const height = vertical ? images.reduce((s, i) => s + i.height, 0) + gap * (images.length - 1) : Math.max(...images.map((i) => i.height));
  const out = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    out.data[i * 4] = GAP_COLOR[0];
    out.data[i * 4 + 1] = GAP_COLOR[1];
    out.data[i * 4 + 2] = GAP_COLOR[2];
    out.data[i * 4 + 3] = 255;
  }
  let offset = 0;
  for (const image of images) {
    PNG.bitblt(image, out, 0, 0, image.width, image.height, vertical ? 0 : offset, vertical ? offset : 0);
    offset += (vertical ? image.height : image.width) + gap;
  }
  return out;
}

export function encode(png: PNG): Buffer {
  return PNG.sync.write(png, { deflateLevel: 9, filterType: -1 });
}
