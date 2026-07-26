import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useDebounce } from "./useDebounce";

describe("useDebounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retorna o valor inicial imediatamente", () => {
    const { result } = renderHook(() => useDebounce("abc", 150));
    expect(result.current).toBe("abc");
  });

  it("só propaga o novo valor após o atraso (150ms do PRD)", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 150),
      { initialProps: { value: "" } },
    );

    rerender({ value: "cor" });
    expect(result.current).toBe("");

    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe("");

    act(() => vi.advanceTimersByTime(50));
    expect(result.current).toBe("cor");
  });

  it("reinicia o timer a cada digitação (não propaga valores intermediários)", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 150),
      { initialProps: { value: "" } },
    );

    rerender({ value: "c" });
    act(() => vi.advanceTimersByTime(100));
    rerender({ value: "co" });
    act(() => vi.advanceTimersByTime(100));
    rerender({ value: "cor" });
    expect(result.current).toBe("");

    act(() => vi.advanceTimersByTime(150));
    expect(result.current).toBe("cor");
  });
});
