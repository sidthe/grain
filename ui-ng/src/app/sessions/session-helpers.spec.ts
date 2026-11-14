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

import { describe, expect, it } from "vitest";
import { formatSessionDuration } from "./session-helpers";

describe("formatSessionDuration", () => {
  it("returns Invalid for negative and non-finite inputs", () => {
    expect(formatSessionDuration(-1)).toBe("Invalid");
    expect(formatSessionDuration(-0.001)).toBe("Invalid");
    expect(formatSessionDuration(-1000)).toBe("Invalid");
    expect(formatSessionDuration(-60000)).toBe("Invalid");
    expect(formatSessionDuration(Number.NaN)).toBe("Invalid");
    expect(formatSessionDuration(Number.POSITIVE_INFINITY)).toBe("Invalid");
    expect(formatSessionDuration(Number.NEGATIVE_INFINITY)).toBe("Invalid");
  });

  it("formats sub-second durations in milliseconds", () => {
    expect(formatSessionDuration(0)).toBe("0ms");
    expect(formatSessionDuration(-0)).toBe("0ms");
    expect(formatSessionDuration(1)).toBe("1ms");
    expect(formatSessionDuration(12.5)).toBe("12.5ms");
    expect(formatSessionDuration(500)).toBe("500ms");
    expect(formatSessionDuration(999)).toBe("999ms");
    expect(formatSessionDuration(999.9)).toBe("999.9ms");
  });

  it("formats durations under one minute as floored seconds", () => {
    expect(formatSessionDuration(1000)).toBe("1s");
    expect(formatSessionDuration(1500)).toBe("1s");
    expect(formatSessionDuration(1999)).toBe("1s");
    expect(formatSessionDuration(59000)).toBe("59s");
    expect(formatSessionDuration(59999)).toBe("59s");
    expect(formatSessionDuration(59999.9)).toBe("59s");
  });

  it("formats durations of one minute or more as floored minutes", () => {
    expect(formatSessionDuration(60000)).toBe("1m");
    expect(formatSessionDuration(60999)).toBe("1m");
    expect(formatSessionDuration(119999)).toBe("1m");
    expect(formatSessionDuration(120000)).toBe("2m");
    expect(formatSessionDuration(3600000)).toBe("60m");
    expect(formatSessionDuration(Number.MAX_SAFE_INTEGER)).toBe(
      "150119987579m",
    );
  });
});
