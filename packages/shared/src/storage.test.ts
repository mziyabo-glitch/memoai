import { describe, expect, it } from "vitest";
import { formatFileSize, totalRecordingBytes } from "./storage";

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

describe("formatFileSize", () => {
  it("uses KB, MB, or GB from the byte count", () => {
    expect(formatFileSize(0)).toBe("0 KB");
    expect(formatFileSize(512)).toBe("0.5 KB");
    expect(formatFileSize(KB)).toBe("1 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(10 * KB)).toBe("10 KB");
    expect(formatFileSize(MB)).toBe("1 MB");
    expect(formatFileSize(1.5 * MB)).toBe("1.5 MB");
    expect(formatFileSize(100 * MB)).toBe("100 MB");
    expect(formatFileSize(GB)).toBe("1 GB");
    expect(formatFileSize(2.5 * GB)).toBe("2.5 GB");
  });

  it("does not present a non-empty file as 0 KB", () => {
    expect(formatFileSize(1)).toBe("0.1 KB");
    expect(formatFileSize(100)).toBe("0.1 KB");
  });

  it("treats invalid counts as empty", () => {
    expect(formatFileSize(-1)).toBe("0 KB");
    expect(formatFileSize(Number.NaN)).toBe("0 KB");
    expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe("0 KB");
  });
});

describe("totalRecordingBytes", () => {
  it("adds on-disk sizes", () => {
    expect(totalRecordingBytes([KB, 2 * KB, 512])).toBe(KB + 2 * KB + 512);
    expect(totalRecordingBytes([])).toBe(0);
  });

  it("ignores invalid sizes and keeps the rest", () => {
    expect(totalRecordingBytes([MB, -20, Number.NaN, 0])).toBe(MB);
  });
});
