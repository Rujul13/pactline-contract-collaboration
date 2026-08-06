import assert from "node:assert/strict";
import test from "node:test";
import { diffText } from "../lib/text-diff.ts";

function changedText(segments: Array<{ text: string; changed: boolean }>) {
  return segments.filter((segment) => segment.changed).map((segment) => segment.text).join("");
}

test("highlights only a sentence appended to a proposal", () => {
  const original = "Invoices are payable within thirty days.";
  const proposed = "Invoices are payable within thirty days. Late payments accrue interest.";
  const diff = diffText(original, proposed);
  assert.equal(changedText(diff.original), "");
  assert.equal(changedText(diff.proposed), " Late payments accrue interest.");
  assert.equal(diff.original.map((segment) => segment.text).join(""), original);
  assert.equal(diff.proposed.map((segment) => segment.text).join(""), proposed);
});

test("highlights a replaced term without marking the full paragraph", () => {
  const original = "The liability cap is thirty percent of the fees paid.";
  const proposed = "The liability cap is forty percent of the fees paid.";
  const diff = diffText(original, proposed);
  assert.equal(changedText(diff.original), "thirty");
  assert.equal(changedText(diff.proposed), "forty");
});
