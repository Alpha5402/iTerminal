import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { RuntimeError } from "@iterminal/domain";

const MAX_CREDENTIAL_FILE_BYTES = 64 * 1_024;

export async function readPrivateRuntimeRpcCredentialFile(
  path: string,
  source: string,
): Promise<unknown> {
  if (!isAbsolute(path)) {
    throw new RuntimeError("INVALID_REQUEST", "Runtime RPC credential file path must be absolute");
  }

  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (nodeErrorCode(error) === "ELOOP") throw invalidSource(source);
    throw unavailableSource(source);
  }

  let contents: string;
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > MAX_CREDENTIAL_FILE_BYTES ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())
    ) {
      throw invalidSource(source);
    }
    const bytes = Buffer.alloc(MAX_CREDENTIAL_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = await file.read(bytes, length, bytes.length - length);
      length += read.bytesRead;
      if (length > MAX_CREDENTIAL_FILE_BYTES) throw invalidSource(source);
      if (read.bytesRead === 0) break;
    }
    contents = bytes.subarray(0, length).toString("utf8");
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw unavailableSource(source);
  } finally {
    await file.close().catch(() => undefined);
  }

  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw invalidSource(source);
  }
}

function invalidSource(source: string): RuntimeError {
  return new RuntimeError(
    "POLICY_DENIED",
    "Runtime RPC credential file must be one private bounded JSON file",
    { source },
  );
}

function unavailableSource(source: string): RuntimeError {
  return new RuntimeError(
    "RUNTIME_UNAVAILABLE",
    "Runtime RPC credential source is temporarily unavailable",
    { source },
    true,
  );
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as Error & { readonly code?: string }).code
    : undefined;
}
