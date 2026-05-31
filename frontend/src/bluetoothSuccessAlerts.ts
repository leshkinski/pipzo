import { shouldSuppressBluetoothSuccessAlert } from "./viewModel";

export const bluetoothSuccessAlertSuppressedEvent = "pipzo:bluetooth-success-alert-suppressed";

export type BluetoothSuccessAlertSuppressedDetail = {
  message: string;
};

type AlertWindow = Pick<Window, "alert" | "dispatchEvent">;

let installedWindow: AlertWindow | null = null;
let originalAlert: ((message?: unknown) => void) | null = null;

export function handleBluetoothSuccessAlert(
  message: unknown,
  forwardAlert: (message?: unknown) => void,
  onSuppressed: (message: string) => void,
): boolean {
  const text = typeof message === "string" ? message : String(message ?? "");
  if (!shouldSuppressBluetoothSuccessAlert(text)) {
    forwardAlert(message);
    return false;
  }

  onSuppressed(text);
  return true;
}

export function installBluetoothSuccessAlertSuppression(alertWindow: AlertWindow = window): () => void {
  if (installedWindow === alertWindow) {
    return uninstallBluetoothSuccessAlertSuppression;
  }

  originalAlert = alertWindow.alert;
  installedWindow = alertWindow;
  alertWindow.alert = (message?: unknown) => {
    handleBluetoothSuccessAlert(message, originalAlert?.bind(alertWindow) ?? (() => undefined), (text) => {
      alertWindow.dispatchEvent(
        new CustomEvent<BluetoothSuccessAlertSuppressedDetail>(bluetoothSuccessAlertSuppressedEvent, {
          detail: { message: text },
        }),
      );
    });
  };

  return uninstallBluetoothSuccessAlertSuppression;
}

export function uninstallBluetoothSuccessAlertSuppression() {
  if (installedWindow && originalAlert) {
    installedWindow.alert = originalAlert;
  }
  installedWindow = null;
  originalAlert = null;
}
