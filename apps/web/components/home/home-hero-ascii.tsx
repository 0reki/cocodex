"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

type HomeHeroAsciiProps = {};

const CHARSET = "○>_ ";
const CONTRAST = 2;
const GAMMA = 0.5;
const INVERT_LUMA = true;
const FONT_SIZE = 9;
const CELL_PADDING_X = 1;
const CELL_PADDING_Y = 2;
const TARGET_FPS = 30;
const LUMA_SMOOTHING_MS = 1000;
const MASK_RESOLUTION_SCALE = 0.8;
const FORCE_SCALE = 0.5;
const HOVER_RADIUS = 28;
const SPLASH_RANGE = 184;
const SPLASH_VELOCITY_SCALE = 3;
const SPLASH_FORCE_SCALE = 2;
const SPLASH_DENSITY = 0.12;
const SPLASH_RANDOMNESS = 0.14;
const SPLASH_THICKNESS = 100;
const SPLASH_TRAVEL_EASE_POWER = 2.5;
const SPLASH_FORCE_DECAY_POWER = 1.2;
const SPLASH_DENSITY_DECAY_POWER = 2;
const DRAG_BOOST_SCALE = 0.03;
const DRAG_BOOST_MAX = 60;
const DRAG_THRESHOLD = 6;
const DIFFUSION = 1.5;
const DIFFUSION_ITERATIONS = 5;
const VELOCITY_DISSIPATION = 0.1;
const DENSITY_DISSIPATION = 0.1;
const MASK_STRENGTH = 0.9;
const PROJECT_ITERATIONS = 10;
const SAFE_AREA_FADE = 60;
const ASCII_FONT_STACK = "SF Mono, Consolas, Liberation Mono, ui-monospace, monospace";
const DEFAULT_ASCII_COLOR = "rgba(255,255,255,0.8)";
const DEFAULT_CELL_ASPECT_RATIO = 5 / 3;

type FluidField = {
  width: number;
  height: number;
  size: number;
  density: Float32Array;
  density0: Float32Array;
  velX: Float32Array;
  velY: Float32Array;
  velX0: Float32Array;
  velY0: Float32Array;
  pressure: Float32Array;
  divergence: Float32Array;
};

type Layout = {
  widthCss: number;
  heightCss: number;
  cols: number;
  rows: number;
  dpr: number;
  cellWidth: number;
  cellHeight: number;
  drawCellWidth: number;
  drawCellHeight: number;
  padX: number;
  padY: number;
  tileW: number;
  tileH: number;
  spaceIndex: number;
};

type SafeRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type PointerSample = {
  x: number;
  y: number;
  time: number;
};

type Ripple = {
  normX: number;
  normY: number;
  startedAt: number;
  seed: number;
  maxRadiusPx: number;
  thicknessPx: number;
};

type ObjectPosition = {
  x: number;
  y: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function smooth01(value: number) {
  const clamped = clamp(value, 0, 1);
  return clamped * clamped * (3 - 2 * clamped);
}

function bilerp(field: Float32Array, x: number, y: number, width: number, height: number) {
  const clampedX = clamp(x, 0, width - 1);
  const clampedY = clamp(y, 0, height - 1);
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = clampedX - x0;
  const ty = clampedY - y0;
  const i00 = y0 * width + x0;
  const i10 = y0 * width + x1;
  const i01 = y1 * width + x0;
  const i11 = y1 * width + x1;
  const top = field[i00]! + (field[i10]! - field[i00]!) * tx;
  const bottom = field[i01]! + (field[i11]! - field[i01]!) * tx;
  return top + (bottom - top) * ty;
}

function advect(
  out: Float32Array,
  source: Float32Array,
  velX: Float32Array,
  velY: Float32Array,
  dt: number,
  width: number,
  height: number,
) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      out[index] = bilerp(source, x - velX[index]! * dt, y - velY[index]! * dt, width, height);
    }
  }
}

function diffuse(
  out: Float32Array,
  source: Float32Array,
  amount: number,
  iterations: number,
  width: number,
  height: number,
) {
  if (amount <= 0 || iterations <= 0) {
    out.set(source);
    return;
  }

  out.set(source);
  const denominator = 1 / (1 + 4 * amount);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const left = out[y * width + Math.max(0, x - 1)] ?? 0;
        const right = out[y * width + Math.min(width - 1, x + 1)] ?? 0;
        const up = out[Math.max(0, y - 1) * width + x] ?? 0;
        const down = out[Math.min(height - 1, y + 1) * width + x] ?? 0;
        out[index] = (source[index]! + amount * (left + right + up + down)) * denominator;
      }
    }
  }
}

function project(field: FluidField, iterations: number) {
  if (iterations <= 0) return;

  const { width, height, velX, velY, pressure, divergence } = field;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const left = velX[y * width + Math.max(0, x - 1)] ?? 0;
      const right = velX[y * width + Math.min(width - 1, x + 1)] ?? 0;
      const up = velY[Math.max(0, y - 1) * width + x] ?? 0;
      const down = velY[Math.min(height - 1, y + 1) * width + x] ?? 0;
      divergence[index] = -0.5 * (right - left + down - up);
      pressure[index] = 0;
    }
  }

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const left = pressure[y * width + Math.max(0, x - 1)] ?? 0;
        const right = pressure[y * width + Math.min(width - 1, x + 1)] ?? 0;
        const up = pressure[Math.max(0, y - 1) * width + x] ?? 0;
        const down = pressure[Math.min(height - 1, y + 1) * width + x] ?? 0;
        pressure[index] = (divergence[index]! + left + right + up + down) / 4;
      }
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const left = pressure[y * width + Math.max(0, x - 1)] ?? 0;
      const right = pressure[y * width + Math.min(width - 1, x + 1)] ?? 0;
      const up = pressure[Math.max(0, y - 1) * width + x] ?? 0;
      const down = pressure[Math.min(height - 1, y + 1) * width + x] ?? 0;
      field.velX[index] = field.velX[index]! - 0.5 * (right - left);
      field.velY[index] = field.velY[index]! - 0.5 * (down - up);
    }
  }
}

function createField(width: number, height: number): FluidField {
  const size = width * height;
  return {
    width,
    height,
    size,
    density: new Float32Array(size),
    density0: new Float32Array(size),
    velX: new Float32Array(size),
    velY: new Float32Array(size),
    velX0: new Float32Array(size),
    velY0: new Float32Array(size),
    pressure: new Float32Array(size),
    divergence: new Float32Array(size),
  };
}

function applyRadialForce(
  field: FluidField,
  centerX: number,
  centerY: number,
  velX: number,
  velY: number,
  densityStrength: number,
  radius: number,
) {
  if (radius <= 0 || densityStrength <= 0) return;

  const { width, height } = field;
  const radiusSq = radius * radius;
  const minX = Math.max(0, Math.floor(centerX - radius));
  const maxX = Math.min(width - 1, Math.ceil(centerX + radius));
  const minY = Math.max(0, Math.floor(centerY - radius));
  const maxY = Math.min(height - 1, Math.ceil(centerY + radius));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > radiusSq) continue;
      const falloff = smooth01(1 - Math.sqrt(distanceSq) / radius);
      const index = y * width + x;
      field.velX[index] = field.velX[index]! + velX * falloff;
      field.velY[index] = field.velY[index]! + velY * falloff;
      field.density[index] = clamp(field.density[index]! + densityStrength * falloff, 0, 1);
    }
  }
}

function applySplash(
  field: FluidField,
  centerX: number,
  centerY: number,
  force: number,
  density: number,
  radiusPx: number,
  thicknessPx: number,
  randomness: number,
  seed: number,
  pixelsPerFieldX: number,
  pixelsPerFieldY: number,
  easedTravel: number,
) {
  if (
    radiusPx <= 0 ||
    thicknessPx <= 0 ||
    (force <= 0 && density <= 0) ||
    pixelsPerFieldX <= 0 ||
    pixelsPerFieldY <= 0
  ) {
    return;
  }

  const { width, height } = field;
  const outerX = (radiusPx + thicknessPx) / pixelsPerFieldX;
  const outerY = (radiusPx + thicknessPx) / pixelsPerFieldY;
  const minX = Math.max(0, Math.floor(centerX - outerX));
  const maxX = Math.min(width - 1, Math.ceil(centerX + outerX));
  const minY = Math.max(0, Math.floor(centerY - outerY));
  const maxY = Math.min(height - 1, Math.ceil(centerY + outerY));

  for (let y = minY; y <= maxY; y += 1) {
    const offsetYPx = (y - centerY) * pixelsPerFieldY;
    for (let x = minX; x <= maxX; x += 1) {
      const offsetXPx = (x - centerX) * pixelsPerFieldX;
      const distance = Math.hypot(offsetXPx, offsetYPx);
      const angle = Math.atan2(offsetYPx, offsetXPx);
      const noise =
        0.5 * Math.sin(6 * angle + seed) +
        0.25 * Math.sin(3 * angle + 0.05 * distance + 0.3 * seed) +
        0.5;
      const ringScale = clamp(
        1 + randomness * (2 * noise - 1) * (0.35 + 0.65 * easedTravel),
        0.4,
        2.2,
      );
      const bandDistance = Math.abs(distance - radiusPx * ringScale);
      if (bandDistance > thicknessPx) continue;

      const falloff = smooth01(1 - bandDistance / thicknessPx);
      const index = y * width + x;
      if (force > 0 && distance > 0) {
        const invDistance = 1 / distance;
        field.velX[index] = field.velX[index]! + offsetXPx * invDistance * force * falloff;
        field.velY[index] = field.velY[index]! + offsetYPx * invDistance * force * falloff;
      }
      if (density > 0) {
        field.density[index] = clamp(field.density[index]! + density * falloff, 0, 1);
      }
    }
  }
}

function measureGlyph(metrics: TextMetrics, fontSize: number) {
  const hasLeft = Number.isFinite(metrics.actualBoundingBoxLeft);
  const hasRight = Number.isFinite(metrics.actualBoundingBoxRight);
  const left = hasLeft ? metrics.actualBoundingBoxLeft : 0;
  const right = hasRight ? metrics.actualBoundingBoxRight : metrics.width;
  let width = hasLeft && hasRight ? left + right : metrics.width || right;
  if (width === 0 && metrics.width) {
    width = metrics.width;
  }
  return {
    width,
    left,
    ascent: Number.isFinite(metrics.actualBoundingBoxAscent)
      ? metrics.actualBoundingBoxAscent
      : 0.8 * fontSize,
    descent: Number.isFinite(metrics.actualBoundingBoxDescent)
      ? metrics.actualBoundingBoxDescent
      : 0.2 * fontSize,
  };
}

function measureCellAspectRatio(ctx: CanvasRenderingContext2D) {
  const previousFont = ctx.font;
  ctx.font = `100px ${ASCII_FONT_STACK}`;
  const metrics = ctx.measureText("M");
  ctx.font = previousFont;
  const ascent = Number.isFinite(metrics.actualBoundingBoxAscent)
    ? metrics.actualBoundingBoxAscent
    : 80;
  const descent = Number.isFinite(metrics.actualBoundingBoxDescent)
    ? metrics.actualBoundingBoxDescent
    : 20;
  const aspect = (ascent + descent) / (metrics.width || 60);
  return Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_CELL_ASPECT_RATIO;
}

function createLayout(
  widthCss: number,
  heightCss: number,
  dpr: number,
  cellAspectRatio: number,
): Layout {
  const drawCellHeight = FONT_SIZE;
  const drawCellWidth = Math.max(1, drawCellHeight / cellAspectRatio);
  const padX = CELL_PADDING_X;
  const padY = CELL_PADDING_Y;
  const cellWidth = Math.max(1, drawCellWidth + 2 * padX);
  const cellHeight = Math.max(1, drawCellHeight + 2 * padY);
  const cols = Math.max(1, Math.floor(widthCss / cellWidth));
  const rows = Math.max(1, Math.floor(heightCss / cellHeight));
  return {
    widthCss,
    heightCss,
    cols,
    rows,
    dpr,
    cellWidth,
    cellHeight,
    drawCellWidth,
    drawCellHeight,
    padX,
    padY,
    tileW: Math.max(1, Math.round(drawCellWidth * dpr)),
    tileH: Math.max(1, Math.round(drawCellHeight * dpr)),
    spaceIndex: CHARSET.indexOf(" "),
  };
}

function rebuildGlyphAtlas(
  atlasCanvas: HTMLCanvasElement,
  atlasCtx: CanvasRenderingContext2D,
  layout: Layout,
  fillStyle: string,
) {
  if (!layout.tileW || !layout.tileH || CHARSET.length === 0) return;

  atlasCanvas.width = layout.tileW * CHARSET.length;
  atlasCanvas.height = layout.tileH;
  atlasCtx.clearRect(0, 0, atlasCanvas.width, atlasCanvas.height);
  atlasCtx.imageSmoothingEnabled = false;

  const fontPx = layout.tileH;
  atlasCtx.font = `${fontPx}px ${ASCII_FONT_STACK}`;
  atlasCtx.fillStyle = fillStyle;
  atlasCtx.textAlign = "left";
  atlasCtx.textBaseline = "alphabetic";

  const inset = Math.min(1, Math.floor(Math.min(layout.tileW, layout.tileH) / 2));
  const innerWidth = Math.max(1, layout.tileW - 2 * inset);
  const innerHeight = Math.max(1, layout.tileH - 2 * inset);

  let maxWidth = 0;
  let maxAscent = 0;
  let maxDescent = 0;
  for (const char of CHARSET) {
    const glyph = measureGlyph(atlasCtx.measureText(char), fontPx);
    maxWidth = Math.max(maxWidth, glyph.width);
    maxAscent = Math.max(maxAscent, glyph.ascent);
    maxDescent = Math.max(maxDescent, glyph.descent);
  }

  const totalHeight = maxAscent + maxDescent;
  const scaleX = maxWidth > 0 ? (0.92 * innerWidth) / maxWidth : 1;
  const scaleY = totalHeight > 0 ? innerHeight / totalHeight : 1;
  const scale = Number.isFinite(scaleX) && Number.isFinite(scaleY) ? Math.min(scaleX, scaleY) : 1;
  const fittedFontPx = Number.isFinite(scale) && scale > 0 ? fontPx * scale : fontPx;

  atlasCtx.font = `${fittedFontPx}px ${ASCII_FONT_STACK}`;

  const glyphs = CHARSET.split("").map((char) => measureGlyph(atlasCtx.measureText(char), fittedFontPx));
  const fittedDescent = glyphs.reduce((max, glyph) => Math.max(max, glyph.descent), 0);
  const baseline = Math.max(inset, Math.floor(inset + innerHeight - fittedDescent));

  for (let index = 0; index < CHARSET.length; index += 1) {
    const glyph = glyphs[index]!;
    const drawX = Math.round(index * layout.tileW + inset + (innerWidth - glyph.width) / 2 + glyph.left);
    atlasCtx.fillText(CHARSET[index]!, drawX, baseline);
  }
}

function parseObjectPositionValue(value: string | undefined, axis: "x" | "y") {
  if (!value) return 0.5;
  const normalized = value.toLowerCase();
  if (normalized.endsWith("%")) {
    const percent = Number.parseFloat(normalized);
    return Number.isFinite(percent) ? clamp(percent / 100, 0, 1) : 0.5;
  }
  if (axis === "x") {
    if (normalized === "left") return 0;
    if (normalized === "center") return 0.5;
    if (normalized === "right") return 1;
  } else {
    if (normalized === "top") return 0;
    if (normalized === "center") return 0.5;
    if (normalized === "bottom") return 1;
  }
  return 0.5;
}

function parseObjectPosition(position: string): ObjectPosition {
  const parts = position.split(/\s+/).filter(Boolean);
  const [x, y] = parts.length === 1 ? [parts[0], "50%"] : [parts[0], parts[1]];
  return {
    x: parseObjectPositionValue(x, "x"),
    y: parseObjectPositionValue(y, "y"),
  };
}

function computeMediaCrop(
  sourceWidth: number,
  sourceHeight: number,
  destWidth: number,
  destHeight: number,
  fit: string,
  position: ObjectPosition,
) {
  if (!sourceWidth || !sourceHeight || !destWidth || !destHeight) return null;

  if (fit === "contain") {
    const scale = Math.min(destWidth / sourceWidth, destHeight / sourceHeight);
    return {
      sx: 0,
      sy: 0,
      sw: sourceWidth,
      sh: sourceHeight,
      dx: (destWidth - sourceWidth * scale) * position.x,
      dy: (destHeight - sourceHeight * scale) * position.y,
      dw: sourceWidth * scale,
      dh: sourceHeight * scale,
    };
  }

  if (fit === "fill") {
    return {
      sx: 0,
      sy: 0,
      sw: sourceWidth,
      sh: sourceHeight,
      dx: 0,
      dy: 0,
      dw: destWidth,
      dh: destHeight,
    };
  }

  if (fit === "none") {
    return {
      sx: 0,
      sy: 0,
      sw: sourceWidth,
      sh: sourceHeight,
      dx: (destWidth - sourceWidth) * position.x,
      dy: (destHeight - sourceHeight) * position.y,
      dw: sourceWidth,
      dh: sourceHeight,
    };
  }

  const scale = Math.max(destWidth / sourceWidth, destHeight / sourceHeight);
  const cropWidth = destWidth / scale;
  const cropHeight = destHeight / scale;
  return {
    sx: (sourceWidth - cropWidth) * position.x,
    sy: (sourceHeight - cropHeight) * position.y,
    sw: cropWidth,
    sh: cropHeight,
    dx: 0,
    dy: 0,
    dw: destWidth,
    dh: destHeight,
  };
}

function getLocalPoint(root: HTMLElement, clientX: number, clientY: number) {
  const rect = root.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
  return { x, y, rect };
}

function collectSafeRects(root: HTMLElement, selector: string): SafeRect[] {
  const rootRect = root.getBoundingClientRect();
  const rects: SafeRect[] = [];
  for (const node of Array.from(document.querySelectorAll(selector))) {
    if (!(node instanceof HTMLElement) || !node.isConnected) continue;
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const left = Math.max(0, rect.left - rootRect.left);
    const top = Math.max(0, rect.top - rootRect.top);
    const right = Math.min(rootRect.width, rect.right - rootRect.left);
    const bottom = Math.min(rootRect.height, rect.bottom - rootRect.top);
    if (right <= left || bottom <= top) continue;
    rects.push({ left, top, right, bottom });
  }
  return rects;
}

function safeAreaAlpha(rects: SafeRect[], x: number, y: number, fadeSize: number) {
  if (!rects.length) return 1;

  let minDistance = Number.POSITIVE_INFINITY;
  for (const rect of rects) {
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const distance = Math.hypot(dx, dy);
    if (distance === 0) return 0;
    minDistance = Math.min(minDistance, distance);
  }

  return fadeSize <= 0 ? 1 : clamp(minDistance / fadeSize, 0, 1);
}

function CodexHeroContent() {
  const iconVideoRef = useRef<HTMLVideoElement | null>(null);
  const [iconPlaying, setIconPlaying] = useState(false);

  const handleIconClick = () => {
    const video = iconVideoRef.current;
    if (!video) return;
    if (iconPlaying) {
      video.pause();
      try {
        video.currentTime = 0;
      } catch { }
      setIconPlaying(false);
      return;
    }

    void video.play().then(
      () => {
        setIconPlaying(true);
      },
      () => {
        setIconPlaying(false);
      },
    );
  };

  const handleIconEnded = () => {
    const video = iconVideoRef.current;
    if (!video) return;
    try {
      video.currentTime = 0;
    } catch { }
    setIconPlaying(false);
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6">
      <div className="w-full max-w-[980px]">
        <div className="relative flex flex-col items-center text-center">
          <div className="mb-7 flex flex-wrap justify-center" />
          <button
            type="button"
            aria-label="Play Codex icon animation"
            onClick={handleIconClick}
            className="pointer-events-auto cursor-pointer codex-icon-wrap ascii-overlay-safe mb-7 h-[90px] w-[90px] overflow-clip rounded-[24px] shadow-[0_16px_40px_rgba(72,98,232,0.18)]"
          >
            <video
              ref={iconVideoRef}
              className="h-full w-full object-cover"
              playsInline
              muted
              preload="auto"
              poster="/codex-app.webp"
              onEnded={handleIconEnded}
            >
              <source
                src="https://cdn.openai.com/cap/76B4ISvLjfcSygxIvoMqyl/7d037d99808d419313b42980eb181ecg.mp4"
                type="video/mp4"
              />
            </video>
          </button>
          <h1
            className="ascii-overlay-safe scroll-mt-header-h text-balance text-black font-medium tracking-[-0.03em] [font-size:clamp(2rem,calc(2rem+2*((100vw-23.4375rem)/66.5625)),4rem)] [line-height:clamp(2.28rem,calc(2.28rem+1.72*((100vw-23.4375rem)/66.5625)),4rem)]"
          >
            CoCodex
          </h1>
          <div className="mt-6 max-w-[760px]">
            <p className="ascii-overlay-safe text-balance text-[rgba(0,0,0,0.88)] text-[1.0625rem] font-normal leading-[1.7499375rem]">
              以最适合你的方式，充分利用你的Codex。
            </p>
          </div>
          <div className="ascii-overlay-safe mt-10 flex min-h-sm justify-between">
            <div className="flex flex-row flex-wrap items-center justify-center">
              <div className="flex flex-col">
                <div className="relative z-[10] flex flex-wrap items-center justify-center">
                  <div>
                    <Link
                      href="/dashboard"
                      className="pointer-events-auto inline-flex h-[48px] items-center justify-center gap-[0.45em] rounded-full bg-black px-7 text-[14px] font-medium text-white shadow-[0_10px_24px_rgba(0,0,0,0.08)] transition"
                    >
                      进入控制台
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function HomeHeroAscii({ }: HomeHeroAsciiProps) {
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ripplesRef = useRef<Ripple[]>([]);
  const handlePointerMoveRef = useRef<((event: PointerEvent) => void) | null>(null);
  const handlePointerDownRef = useRef<((event: PointerEvent) => void) | null>(null);
  const handlePointerUpRef = useRef<((event: PointerEvent) => void) | null>(null);
  const handlePointerCancelRef = useRef<((event: PointerEvent) => void) | null>(null);

  const videoSrc = useMemo(() => "https://cdn.openai.com/ctf-cdn/floral_a.mp4", []);

  useEffect(() => {
    const section = sectionRef.current;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!section || !video || !canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const sampleCanvas = document.createElement("canvas");
    const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!sampleContext) return;

    const atlasCanvas = document.createElement("canvas");
    const atlasContext = atlasCanvas.getContext("2d");
    if (!atlasContext) return;

    let layout: Layout = {
      widthCss: 0,
      heightCss: 0,
      cols: 0,
      rows: 0,
      dpr: 1,
      cellWidth: 0,
      cellHeight: 0,
      drawCellWidth: 0,
      drawCellHeight: 0,
      padX: 0,
      padY: 0,
      tileW: 0,
      tileH: 0,
      spaceIndex: CHARSET.indexOf(" "),
    };
    let fluid: FluidField | null = null;
    let mask: Float32Array | null = null;
    let smoothedLuma: Float32Array | null = null;
    let safeRects: SafeRect[] = [];
    let lastSimulationAt: number | null = null;
    let lastPresentedAt = 0;
    let rafId = 0;
    let stopped = false;
    let activePointerId: number | null = null;
    let previousPointer: PointerSample | null = null;
    let pointerDownStart: PointerSample | null = null;
    let didDrag = false;
    let cachedColor = "";
    const frameInterval = 1000 / TARGET_FPS;

    const syncSafeRects = () => {
      safeRects = collectSafeRects(section, ".ascii-overlay-safe").filter((rect) => {
        const width = rect.right - rect.left;
        const height = rect.bottom - rect.top;
        return width > 120 || height > 120;
      });
    };

    const syncSize = () => {
      const rect = section.getBoundingClientRect();
      const widthCss = Math.max(1, rect.width);
      const heightCss = Math.max(1, rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cellAspectRatio = measureCellAspectRatio(atlasContext);
      layout = createLayout(widthCss, heightCss, dpr, cellAspectRatio);

      canvas.width = Math.max(1, Math.round(widthCss * dpr));
      canvas.height = Math.max(1, Math.round(heightCss * dpr));
      canvas.style.width = `${widthCss}px`;
      canvas.style.height = `${heightCss}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.imageSmoothingEnabled = false;

      sampleCanvas.width = layout.cols;
      sampleCanvas.height = layout.rows;

      fluid = createField(
        Math.max(1, Math.round(layout.cols * MASK_RESOLUTION_SCALE)),
        Math.max(1, Math.round(layout.rows * MASK_RESOLUTION_SCALE)),
      );
      mask = new Float32Array(layout.cols * layout.rows);
      smoothedLuma = new Float32Array(layout.cols * layout.rows);
      lastSimulationAt = null;
      lastPresentedAt = 0;
      syncSafeRects();

      const nextColor = getComputedStyle(canvas).color || DEFAULT_ASCII_COLOR;
      cachedColor = nextColor;
      rebuildGlyphAtlas(atlasCanvas, atlasContext, layout, nextColor);
    };

    const ensureGlyphAtlas = () => {
      const nextColor = getComputedStyle(canvas).color || DEFAULT_ASCII_COLOR;
      if (nextColor !== cachedColor) {
        cachedColor = nextColor;
        rebuildGlyphAtlas(atlasCanvas, atlasContext, layout, nextColor);
      }
    };

    const renderFrame = (timestamp: number) => {
      if (stopped || timestamp - lastPresentedAt < frameInterval) return;
      lastPresentedAt = timestamp;
      context.clearRect(0, 0, layout.widthCss, layout.heightCss);
      const field = fluid;
      if (video.readyState < 2 || !field || !mask || !smoothedLuma || layout.cols <= 0 || layout.rows <= 0) {
        return;
      }

      const crop = computeMediaCrop(
        video.videoWidth,
        video.videoHeight,
        layout.widthCss,
        layout.heightCss,
        getComputedStyle(video).objectFit || "cover",
        parseObjectPosition(getComputedStyle(video).objectPosition || "50% 50%"),
      );
      if (!crop) return;

      try {
        sampleContext.clearRect(0, 0, layout.cols, layout.rows);
        sampleContext.drawImage(
          video,
          crop.sx,
          crop.sy,
          crop.sw,
          crop.sh,
          0,
          0,
          layout.cols,
          layout.rows,
        );
      } catch {
        return;
      }

      ensureGlyphAtlas();

      const pixels = sampleContext.getImageData(0, 0, layout.cols, layout.rows).data;
      const frameDeltaMs = lastSimulationAt == null ? 0 : timestamp - lastSimulationAt;
      lastSimulationAt = timestamp;
      const dt = clamp(frameDeltaMs / 1000, 0.001, 0.1);

      const maxTravelPerSecond = 240 * SPLASH_VELOCITY_SCALE;
      ripplesRef.current = ripplesRef.current.filter((ripple) => {
        const ageMs = timestamp - ripple.startedAt;
        if (ageMs < 0) return true;
        const maxRadius = Math.max(1, ripple.maxRadiusPx);
        const durationMs = (maxRadius / Math.max(1, maxTravelPerSecond)) * 1000;
        if (ageMs > durationMs) return false;

        const progress = clamp(ageMs / durationMs, 0, 1);
        const easedTravel = 1 - Math.pow(1 - progress, SPLASH_TRAVEL_EASE_POWER);
        const radiusPx = easedTravel * maxRadius;
        const forceFalloff = Math.pow(Math.max(0, 1 - progress), SPLASH_FORCE_DECAY_POWER);
        const densityFalloff = Math.pow(Math.max(0, 1 - progress), SPLASH_DENSITY_DECAY_POWER);
        const pixelsPerFieldX = field.width > 1 ? layout.widthCss / (field.width - 1) : 0;
        const pixelsPerFieldY = field.height > 1 ? layout.heightCss / (field.height - 1) : 0;

        applySplash(
          field,
          ripple.normX * Math.max(1, field.width - 1),
          ripple.normY * Math.max(1, field.height - 1),
          FORCE_SCALE * SPLASH_FORCE_SCALE * SPLASH_VELOCITY_SCALE * forceFalloff * 20,
          SPLASH_DENSITY * densityFalloff,
          radiusPx,
          ripple.thicknessPx,
          SPLASH_RANDOMNESS,
          ripple.seed,
          pixelsPerFieldX,
          pixelsPerFieldY,
          easedTravel,
        );
        return true;
      });

      field.velX0.set(field.velX);
      field.velY0.set(field.velY);
      diffuse(field.velX, field.velX0, DIFFUSION, DIFFUSION_ITERATIONS, field.width, field.height);
      diffuse(field.velY, field.velY0, DIFFUSION, DIFFUSION_ITERATIONS, field.width, field.height);
      project(field, PROJECT_ITERATIONS);

      field.velX0.set(field.velX);
      field.velY0.set(field.velY);
      advect(field.velX, field.velX0, field.velX0, field.velY0, dt, field.width, field.height);
      advect(field.velY, field.velY0, field.velX0, field.velY0, dt, field.width, field.height);
      project(field, PROJECT_ITERATIONS);

      field.density0.set(field.density);
      advect(field.density, field.density0, field.velX, field.velY, dt, field.width, field.height);

      const velocityDecay = Math.exp(-VELOCITY_DISSIPATION * dt);
      const densityDecay = Math.exp(-DENSITY_DISSIPATION * dt);
      for (let index = 0; index < field.size; index += 1) {
        field.velX[index] = field.velX[index]! * velocityDecay;
        field.velY[index] = field.velY[index]! * velocityDecay;
        field.density[index] = field.density[index]! * densityDecay;
      }

      const sampleStepX = layout.cols > 1 ? (field.width - 1) / (layout.cols - 1) : 0;
      const sampleStepY = layout.rows > 1 ? (field.height - 1) / (layout.rows - 1) : 0;
      for (let row = 0; row < layout.rows; row += 1) {
        const sampleY = row * sampleStepY;
        const rowOffset = row * layout.cols;
        for (let col = 0; col < layout.cols; col += 1) {
          mask[rowOffset + col] = clamp(
            bilerp(field.density, col * sampleStepX, sampleY, field.width, field.height),
            0,
            1,
          );
        }
      }

      const smoothingAlpha =
        LUMA_SMOOTHING_MS <= 0 ? 1 : clamp(1 - Math.exp(-frameDeltaMs / LUMA_SMOOTHING_MS), 0, 1);
      let currentAlpha = 1;
      let currentFillStyle = DEFAULT_ASCII_COLOR;
      let visibleCount = 0;

      for (let row = 0; row < layout.rows; row += 1) {
        for (let col = 0; col < layout.cols; col += 1) {
          const index = row * layout.cols + col;
          const fieldMask = mask[index] ?? 0;
          const pixelOffset = index * 4;
          const red = pixels[pixelOffset] ?? 0;
          const green = pixels[pixelOffset + 1] ?? 0;
          const blue = pixels[pixelOffset + 2] ?? 0;
          const rawLuma = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
          smoothedLuma[index] =
            frameDeltaMs === 0
              ? rawLuma
              : smoothedLuma[index]! + (rawLuma - smoothedLuma[index]!) * smoothingAlpha;

          const maskedLuma = INVERT_LUMA ? smoothedLuma[index]! * fieldMask : smoothedLuma[index]! * fieldMask + (1 - fieldMask);
          let mappedLuma = clamp((maskedLuma - 0.5) * CONTRAST + 0.5, 0, 1);
          mappedLuma = Math.pow(mappedLuma, GAMMA);
          const lumaForCharset = INVERT_LUMA ? 1 - mappedLuma : mappedLuma;
          const charIndex = Math.max(
            0,
            Math.min(CHARSET.length - 1, Math.floor(lumaForCharset * CHARSET.length)),
          );
          if (charIndex === layout.spaceIndex) continue;
          visibleCount += 1;

          const centerX = col * layout.cellWidth + 0.5 * layout.cellWidth;
          const centerY = row * layout.cellHeight + 0.5 * layout.cellHeight;
          const alpha = safeAreaAlpha(safeRects, centerX, centerY, SAFE_AREA_FADE);
          if (alpha <= 0) continue;
          if (alpha !== currentAlpha) {
            context.globalAlpha = alpha;
            currentAlpha = alpha;
          }
          if (cachedColor !== currentFillStyle) {
            currentFillStyle = cachedColor;
          }
          context.drawImage(
            atlasCanvas,
            charIndex * layout.tileW,
            0,
            layout.tileW,
            layout.tileH,
            col * layout.cellWidth + layout.padX,
            row * layout.cellHeight + layout.padY,
            layout.drawCellWidth,
            layout.drawCellHeight,
          );
        }
      }

      context.globalAlpha = 1;
    };

    const scheduleFrame = () => {
      if (stopped) return;
      rafId = window.requestAnimationFrame((timestamp) => {
        renderFrame(timestamp);
        scheduleFrame();
      });
    };

    const handlePointerMove = (event: PointerEvent) => {
      const local = getLocalPoint(section, event.clientX, event.clientY);

      const isActivePointer = activePointerId === event.pointerId;
      const allowHover = !event.pointerType || event.pointerType === "mouse";
      if (!allowHover && !isActivePointer) return;
      if (!local) {
        previousPointer = null;
        return;
      }
      if (!fluid || layout.widthCss <= 0 || layout.heightCss <= 0) {
        previousPointer = { x: event.clientX, y: event.clientY, time: event.timeStamp };
        return;
      }

      const dx = previousPointer ? event.clientX - previousPointer.x : event.movementX || 0;
      const dy = previousPointer ? event.clientY - previousPointer.y : event.movementY || 0;
      const delta = Math.hypot(dx, dy);
      const eventDt = previousPointer
        ? clamp((event.timeStamp - previousPointer.time) / 1000, 0.001, 0.05)
        : 0.016;

      if (
        isActivePointer &&
        pointerDownStart &&
        Math.hypot(event.clientX - pointerDownStart.x, event.clientY - pointerDownStart.y) >= DRAG_THRESHOLD
      ) {
        didDrag = true;
      }

      const fieldScaleX = fluid.width / layout.widthCss;
      const fieldScaleY = fluid.height / layout.heightCss;
      const dragBoost =
        isActivePointer && didDrag ? Math.min(DRAG_BOOST_MAX, (delta / eventDt) * DRAG_BOOST_SCALE) : 0;

      applyRadialForce(
        fluid,
        (local.x / layout.widthCss) * Math.max(1, fluid.width - 1),
        (local.y / layout.heightCss) * Math.max(1, fluid.height - 1),
        (dx / eventDt) * fieldScaleX * FORCE_SCALE,
        (dy / eventDt) * fieldScaleY * FORCE_SCALE,
        MASK_STRENGTH,
        (HOVER_RADIUS + dragBoost) * Math.min(fieldScaleX, fieldScaleY),
      );

      previousPointer = { x: event.clientX, y: event.clientY, time: event.timeStamp };
    };

    const handlePointerDown = (event: PointerEvent) => {
      const local = getLocalPoint(section, event.clientX, event.clientY);

      if (!event.isPrimary) return;
      if (!local) return;
      activePointerId = event.pointerId;
      pointerDownStart = { x: event.clientX, y: event.clientY, time: event.timeStamp };
      previousPointer = { x: event.clientX, y: event.clientY, time: event.timeStamp };
      didDrag = false;
    };

    const handlePointerUp = (event: PointerEvent) => {
      const local = getLocalPoint(section, event.clientX, event.clientY);

      if (!event.isPrimary || activePointerId !== event.pointerId) return;

      if (local && !didDrag) {
        const { rect, x, y } = local;
        const maxRadius = Math.max(
          Math.hypot(x, y),
          Math.hypot(x, rect.height - y),
          Math.hypot(rect.width - x, y),
          Math.hypot(rect.width - x, rect.height - y),
        );
        ripplesRef.current.push({
          normX: clamp(x / Math.max(1, rect.width), 0, 1),
          normY: clamp(y / Math.max(1, rect.height), 0, 1),
          startedAt: event.timeStamp,
          seed: Math.random() * 1000,
          maxRadiusPx: Math.min(SPLASH_RANGE, maxRadius),
          thicknessPx: SPLASH_THICKNESS,
        });
      }

      activePointerId = null;
      previousPointer = null;
      pointerDownStart = null;
      didDrag = false;
    };

    const handlePointerCancel = (event: PointerEvent) => {
      if (activePointerId !== event.pointerId) return;
      activePointerId = null;
      previousPointer = null;
      pointerDownStart = null;
      didDrag = false;
    };

    handlePointerMoveRef.current = handlePointerMove;
    handlePointerDownRef.current = handlePointerDown;
    handlePointerUpRef.current = handlePointerUp;
    handlePointerCancelRef.current = handlePointerCancel;

    const start = async () => {
      syncSize();
      if (stopped) return;
      try {
        await video.play();
      } catch {
        // Ignore autoplay failures; the poster still renders.
      }
      scheduleFrame();
    };

    const resizeObserver = new ResizeObserver(syncSize);
    resizeObserver.observe(section);
    window.addEventListener("scroll", syncSafeRects, { passive: true });
    window.addEventListener("resize", syncSafeRects);
    void start();

    return () => {
      stopped = true;
      resizeObserver.disconnect();
      handlePointerMoveRef.current = null;
      handlePointerDownRef.current = null;
      handlePointerUpRef.current = null;
      handlePointerCancelRef.current = null;
      window.removeEventListener("scroll", syncSafeRects);
      window.removeEventListener("resize", syncSafeRects);
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      video.pause();
    };
  }, []);

  return (
    <section
      ref={sectionRef}
      className="relative min-h-svh overflow-hidden bg-[rgb(239,238,254)] text-white"
      onPointerMove={(event: ReactPointerEvent<HTMLDivElement>) => {
        handlePointerMoveRef.current?.(event.nativeEvent);
      }}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        handlePointerDownRef.current?.(event.nativeEvent);
      }}
      onPointerUp={(event: ReactPointerEvent<HTMLDivElement>) => {
        handlePointerUpRef.current?.(event.nativeEvent);
      }}
      onPointerCancel={(event: ReactPointerEvent<HTMLDivElement>) => {
        handlePointerCancelRef.current?.(event.nativeEvent);
      }}
      onPointerLeave={(event: ReactPointerEvent<HTMLDivElement>) => {
        handlePointerCancelRef.current?.(event.nativeEvent);
      }}
    >
      <div className="pointer-events-none absolute inset-0 bg-[url('/floral_a.webp')] bg-cover bg-center" />
      <video
        ref={videoRef}
        className="pointer-events-none absolute inset-0 h-full w-full object-cover object-center"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        poster="/floral_a.webp"
        crossOrigin="anonymous"
      >
        <source src={videoSrc} type="video/mp4" />
      </video>
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 text-[rgba(255,255,255,0.8)] [mask-image:linear-gradient(to_bottom,rgba(0,0,0,1)_0px,rgba(0,0,0,1)_560px,rgba(0,0,0,0)_1200px)]"
      />
      <CodexHeroContent />
      <style jsx>{`
        .codex-icon-wrap {
          animation: codex-float 5.6s cubic-bezier(0.37, 0, 0.18, 1) infinite;
        }

        @keyframes codex-float {
          0%,
          100% {
            transform: translateY(0px);
          }
          50% {
            transform: translateY(-6px);
          }
        }
      `}</style>
    </section>
  );
}
