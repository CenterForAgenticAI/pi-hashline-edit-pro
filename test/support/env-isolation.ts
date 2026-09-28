import { beforeEach } from "vitest";

delete process.env.PI_HASHLINE_DIR;

beforeEach(() => {
  delete process.env.PI_HASHLINE_DIR;
});
