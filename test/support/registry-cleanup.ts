import { afterEach } from "vitest";
import { resetRegistryForTests } from "../../src/anchor-registry";
import { resetBatchStateForTests } from "../../src/batch";
import { drainEnvRestores } from "./env-restores";

afterEach(() => {
  drainEnvRestores();
  resetRegistryForTests();
  resetBatchStateForTests();
});
