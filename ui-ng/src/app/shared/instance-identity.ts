// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { CHLADNI_ROSETTE_PATH } from "./brand-mark";

export type HeaderColorPreset =
  "" | "ocean" | "teal" | "forest" | "amber" | "coral" | "plum" | "slate";

export type HeaderPatternPreset = "" | "dots" | "diagonal" | "grid" | "waves";

export interface HeaderColorOption {
  readonly id: HeaderColorPreset;
  readonly label: string;
  readonly lightFavicon: string;
  readonly darkFavicon: string;
}

export interface HeaderPatternOption {
  readonly id: HeaderPatternPreset;
  readonly label: string;
}

export const MAX_ENVIRONMENT_NAME_LEN = 32;

export const HEADER_COLOR_OPTIONS: readonly HeaderColorOption[] = [
  {
    id: "",
    label: "Default",
    lightFavicon: "#0b57d0",
    darkFavicon: "#a8c7fa",
  },
  {
    id: "ocean",
    label: "Ocean",
    lightFavicon: "#1a73e8",
    darkFavicon: "#669df6",
  },
  {
    id: "teal",
    label: "Teal",
    lightFavicon: "#00796b",
    darkFavicon: "#4db6ac",
  },
  {
    id: "forest",
    label: "Forest",
    lightFavicon: "#1e7e34",
    darkFavicon: "#6dd58c",
  },
  {
    id: "amber",
    label: "Amber",
    lightFavicon: "#b45309",
    darkFavicon: "#f5b041",
  },
  {
    id: "coral",
    label: "Coral",
    lightFavicon: "#c93326",
    darkFavicon: "#f28b82",
  },
  {
    id: "plum",
    label: "Plum",
    lightFavicon: "#7c3aed",
    darkFavicon: "#b794f6",
  },
  {
    id: "slate",
    label: "Slate",
    lightFavicon: "#475569",
    darkFavicon: "#94a3b8",
  },
];

export const HEADER_PATTERN_OPTIONS: readonly HeaderPatternOption[] = [
  { id: "", label: "Solid" },
  { id: "dots", label: "Dots" },
  { id: "diagonal", label: "Stripes" },
  { id: "grid", label: "Grid" },
  { id: "waves", label: "Waves" },
];

const HEADER_COLOR_SET = new Set<string>(HEADER_COLOR_OPTIONS.map((o) => o.id));
const HEADER_PATTERN_SET = new Set<string>(
  HEADER_PATTERN_OPTIONS.map((o) => o.id),
);

export function normalizeHeaderColor(raw: unknown): HeaderColorPreset {
  if (typeof raw !== "string") return "";
  const v = raw.trim();
  return HEADER_COLOR_SET.has(v) ? (v as HeaderColorPreset) : "";
}

export function normalizeHeaderPattern(raw: unknown): HeaderPatternPreset {
  if (typeof raw !== "string") return "";
  const v = raw.trim();
  return HEADER_PATTERN_SET.has(v) ? (v as HeaderPatternPreset) : "";
}

export function headerColorOption(raw: unknown): HeaderColorOption {
  const id = normalizeHeaderColor(raw);
  return (
    HEADER_COLOR_OPTIONS.find((o) => o.id === id) ?? HEADER_COLOR_OPTIONS[0]
  );
}

export function headerPatternOption(raw: unknown): HeaderPatternOption {
  const id = normalizeHeaderPattern(raw);
  return (
    HEADER_PATTERN_OPTIONS.find((o) => o.id === id) ?? HEADER_PATTERN_OPTIONS[0]
  );
}

export function headerColorLabel(raw: unknown): string {
  return headerColorOption(raw).label;
}

export function headerPatternLabel(raw: unknown): string {
  return headerPatternOption(raw).label;
}

export function buildTintedFaviconDataUrl(fill: string): string {
  const safeFill =
    /^#[0-9a-fA-F]{3,8}$|^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/.test(
      fill.trim(),
    )
      ? fill.trim()
      : "#0b57d0";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">` +
    `<defs><clipPath id="grain-mark-clip"><circle cx="64" cy="64" r="56.32"/></clipPath></defs>` +
    `<path clip-path="url(#grain-mark-clip)" fill="${safeFill}" fill-rule="evenodd" d="${CHLADNI_ROSETTE_PATH}"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function stripEnvironmentPrefix(title: string): string {
  const clean = (title || "").replace(/^\[[^\]]+\]\s+/, "").trim();
  return clean || "Grain";
}

export function formatDocumentTitle(
  baseTitle: string,
  environmentName: string,
): string {
  const base = stripEnvironmentPrefix(baseTitle);
  const env = (environmentName || "").trim();
  return env ? `[${env}] ${base}` : base;
}
