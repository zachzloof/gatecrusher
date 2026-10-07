// The gate window's page. Bundled to dist/renderer/gate.js; talks to the app only
// through the `gatecrusher` bridge from preload/gate.ts.
import type { GateState } from "../main/gate-state.ts";

interface GateBridge {
  getState(): Promise<GateState>;
  onState(listener: (state: GateState) => void): void;
  submitCode(code: string): Promise<boolean>;
  openLogs(): void;
  quit(): void;
}

// Put there by preload/gate.ts, which this page is only ever loaded with.
const bridge = (window as unknown as { gatecrusher: GateBridge }).gatecrusher;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`gate.html has no #${id}`);
  return found as T;
}

const sections = ["code", "starting", "expired", "error"] as const;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function render(state: GateState): void {
  for (const id of sections) element(id).hidden = id !== state.mode;
  switch (state.mode) {
    case "code":
      element("code-contact").textContent = state.contact;
      element<HTMLInputElement>("code-input").focus();
      break;
    case "starting":
      element("step").textContent = state.step;
      break;
    case "expired":
      element("expired-at").textContent = formatDate(state.expiredAt);
      element("expired-contact").textContent = state.contact;
      break;
    case "error":
      element("error-detail").textContent = state.message;
      break;
  }
}

const form = element<HTMLFormElement>("code-form");
const input = element<HTMLInputElement>("code-input");
const submit = element<HTMLButtonElement>("code-submit");
const error = element("code-error");

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = input.value;
  if (code.trim() === "") {
    error.textContent = "Enter the code.";
    input.setAttribute("aria-invalid", "true");
    return;
  }
  submit.disabled = true;
  void bridge.submitCode(code).then((accepted) => {
    submit.disabled = false;
    if (accepted) return;
    error.textContent = "That code is not right. Check it and try again.";
    input.setAttribute("aria-invalid", "true");
    input.select();
  });
});

input.addEventListener("input", () => {
  error.textContent = "";
  input.removeAttribute("aria-invalid");
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
  if (action === "quit") bridge.quit();
  if (action === "logs") bridge.openLogs();
});

bridge.onState(render);
void bridge.getState().then(render);
