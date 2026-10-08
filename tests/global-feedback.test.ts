import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  dismissFeedback,
  getFeedbackSnapshot,
  resetFeedbackForTests,
  showFeedback,
} from "../src/services/global-feedback";

afterEach(resetFeedbackForTests);

test("feedback: muestra un evento global con tipo e identificador", () => {
  assert.equal(showFeedback({ id: "network", type: "info", message: "Sin conexión" }), true);
  assert.equal(getFeedbackSnapshot().current?.id, "network");
  assert.equal(getFeedbackSnapshot().current?.type, "info");
});

test("feedback: el mismo evento reemplaza su estado sin apilarse", () => {
  showFeedback({ id: "network", type: "info", message: "Sin conexión" });
  showFeedback({ id: "network", type: "info", message: "Sincronizando..." });
  assert.equal(getFeedbackSnapshot().current?.message, "Sincronizando...");
  assert.equal(getFeedbackSnapshot().queued, 0);
});

test("feedback: un duplicado idéntico se descarta", () => {
  showFeedback({ id: "territory", type: "success", message: "Territorio conquistado" });
  assert.equal(
    showFeedback({ id: "territory", type: "success", message: "Territorio conquistado" }),
    false,
  );
  assert.equal(getFeedbackSnapshot().queued, 0);
});

test("feedback: eventos diferentes esperan en una cola limitada", () => {
  showFeedback({ id: "one", type: "info", message: "Uno" });
  for (let index = 2; index <= 9; index += 1) {
    showFeedback({ id: `item-${index}`, type: "info", message: `Evento ${index}` });
  }
  assert.equal(getFeedbackSnapshot().queued, 5);
});

test("feedback: al cerrar un mensaje avanza al siguiente", () => {
  showFeedback({ id: "one", type: "info", message: "Uno" });
  showFeedback({ id: "two", type: "success", message: "Dos" });
  dismissFeedback();
  assert.equal(getFeedbackSnapshot().current?.id, "two");
});
