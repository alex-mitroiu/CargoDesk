import { useState } from "react";
import { saving } from "../saving";

// Returns [isSaving, withSaving] where withSaving wraps an async function.
// Sets local isSaving for the button spinner, and increments the global saving
// counter so GlobalSavingOverlay blocks the UI for the duration. Optional second
// arg overrides the overlay's default "Processing…" copy (e.g. "Saving…").
const useSaving = () => {
  const [isSaving, setIsSaving] = useState(false);
  const withSaving = async (fn, message) => {
    setIsSaving(true);
    saving.start(message);
    try { await fn(); } finally { setIsSaving(false); saving.end(); }
  };
  return [isSaving, withSaving];
};

export default useSaving;
