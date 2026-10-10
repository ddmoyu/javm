import type { ProcessResult } from "../../platform/neutralino/process";

// curl distinguishes network errors from local I/O, invocation and resume errors.
const curlNetworkErrors = new Set([5, 6, 7, 16, 18, 22, 28, 35, 52, 55, 56, 60, 92, 95, 96, 97]);

export function canRetryWithProxy(kind: "http" | "hls", result: ProcessResult) {
  if (result.exitCode === 0) return false;
  if (kind === "http") return curlNetworkErrors.has(result.exitCode);
  const output = `${result.stdOut}\n${result.stdErr}`;
  if (
    /access (?:to .* )?denied|permission denied|disk full|not enough space|no space left|UnauthorizedAccessException|DirectoryNotFoundException|PathTooLongException|merge failed|error merging|decryption failed/i.test(
      output,
    )
  )
    return false;
  if (
    /HttpRequestException|SocketException|NameResolutionFailure|response status code|\bHTTP[^\r\n]*\b[45]\d\d\b|timed?\s*out|connection (?:refused|reset|closed)|no such host|could not resolve|network is unreachable|SSL connection|TLS handshake|segment[^\r\n]*count[^\r\n]*(?:not pass|mismatch)/i.test(
      output,
    )
  )
    return true;
  // The bundled version may exit 1 without printing the network exception.
  // At this point it has only loaded the manifest URL, before writing media.
  return result.exitCode === 1 && /Loading URL:[^\r\n]+\s*$/.test(output);
}
