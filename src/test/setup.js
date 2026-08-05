import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Without this, each test's render() output stays mounted for the rest of the file (Vitest
// isn't Jest — @testing-library/react's auto-cleanup needs this explicit wiring here since
// vitest.config.js doesn't set test.globals) — later tests' queries then match leftover DOM
// from earlier ones instead of their own render.
afterEach(cleanup);
