import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { installBluetoothSuccessAlertSuppression } from "./bluetoothSuccessAlerts";
import "./styles.css";

installBluetoothSuccessAlertSuppression();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
