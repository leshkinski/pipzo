import { describe, expect, it, vi } from "vitest";

import { handleBluetoothSuccessAlert } from "./bluetoothSuccessAlerts";

describe("Bluetooth success alert suppression", () => {
  it("routes Bluetooth connection success to status handling without forwarding a blocking alert", () => {
    const forwardAlert = vi.fn();
    const onSuppressed = vi.fn();

    const suppressed = handleBluetoothSuccessAlert("Connection successful", forwardAlert, onSuppressed);

    expect(suppressed).toBe(true);
    expect(forwardAlert).not.toHaveBeenCalled();
    expect(onSuppressed).toHaveBeenCalledWith("Connection successful");
  });

  it("leaves unrelated failure and confirmation alerts on the normal alert path", () => {
    const forwardAlert = vi.fn();
    const onSuppressed = vi.fn();

    const suppressed = handleBluetoothSuccessAlert("Speaker pairing failed", forwardAlert, onSuppressed);

    expect(suppressed).toBe(false);
    expect(forwardAlert).toHaveBeenCalledWith("Speaker pairing failed");
    expect(onSuppressed).not.toHaveBeenCalled();
  });
});
