// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalErrorHandlers } from "@/components/GlobalErrorHandlers";
import { Toaster } from "@/components/Toaster";
import { useCopyText } from "@/components/ui/useCopy";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { Providers } from "./support";

// The test runner does not auto-clean the DOM between tests, so unmount each render explicitly.
afterEach(() => {
  cleanup();
});

function CopyProbe({ text }: { text: string }) {
  const { state, copy } = useCopyText();
  return (
    <button type="button" onClick={() => void copy(text)}>
      {state}
    </button>
  );
}

describe("error handling: no silent errors", () => {
  it("a reported error shows an error toast", async () => {
    render(
      <Providers>
        <Toaster />
      </Providers>,
    );
    act(() => {
      errorCenter.report(new Error("boom"), { action: "errors.test.report" });
    });
    expect(await screen.findByRole("alert", {}, { timeout: 5000 })).not.toBeNull();
    expect(screen.getByText("Copy diagnostics")).not.toBeNull();
  });

  it("a success notification shows a status toast", async () => {
    render(
      <Providers>
        <Toaster />
      </Providers>,
    );
    act(() => {
      errorCenter.notify({ key: "toast.saved" });
    });
    expect(await screen.findByRole("status", {}, { timeout: 5000 })).not.toBeNull();
    expect(screen.getByText("Saved")).not.toBeNull();
  });

  it("an uncaught window error is routed to the error center and shown", async () => {
    render(
      <Providers>
        <GlobalErrorHandlers />
        <Toaster />
      </Providers>,
    );
    act(() => {
      window.dispatchEvent(new ErrorEvent("error", { message: "kaboom", error: new Error("kaboom") }));
    });
    expect(await screen.findByRole("alert", {}, { timeout: 5000 })).not.toBeNull();
  });

  it("a failed copy shows the fail state instead of staying quiet", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <Providers>
        <CopyProbe text="INV-20261120-001" />
      </Providers>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByText("fail", {}, { timeout: 5000 })).not.toBeNull();
  });
});
