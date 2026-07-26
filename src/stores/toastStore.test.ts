import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "./toastStore";

describe("toastStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("push adiciona toast com tipo e mensagem", () => {
    useToastStore.getState().push("3 músicas indexadas.", "success");
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe("3 músicas indexadas.");
    expect(toasts[0].kind).toBe("success");
  });

  it("toast some sozinho após 5s", () => {
    useToastStore.getState().push("aviso", "warning");
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("dismiss remove um toast específico", () => {
    useToastStore.getState().push("a", "error");
    useToastStore.getState().push("b", "error");
    const [first] = useToastStore.getState().toasts;
    useToastStore.getState().dismiss(first.id);
    const remaining = useToastStore.getState().toasts;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].message).toBe("b");
  });
});
