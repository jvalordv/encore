/**
 * Sends one file to the service as a multipart form and reports how far the
 * upload has got. `fetch` has no upload progress, so this uses
 * XMLHttpRequest, whose `upload.onprogress` does. It knows nothing of the
 * service's routes or errors: it settles with what came back (a status and a
 * body), or says the network failed or the caller stopped it, and the client
 * (client.ts) turns that into a song status or a ServiceError. The request
 * object is injectable, which is how the tests run with no network.
 */

/** How an upload ended; it never rejects. */
export type UploadResult =
  | { kind: 'response'; status: number; text: string }
  | { kind: 'network' }
  | { kind: 'aborted' };

/** What the upload is told and what it reports. */
export interface UploadOptions {
  /** Called with the share sent, 0 to 1, as the browser reports it. */
  onProgress?: (fraction: number) => void;
  /** Stops the upload at once; it then settles as 'aborted'. */
  signal?: AbortSignal;
  /** Longest the whole exchange may take. */
  timeoutMs: number;
  /** Builds the request; the page's own XMLHttpRequest by default. */
  xhr?: () => XMLHttpRequest;
}

/** Posts `file` as the form field `field` to `url`. */
export function postFile(
  url: string,
  field: string,
  file: File,
  options: UploadOptions,
): Promise<UploadResult> {
  const { signal, onProgress } = options;
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ kind: 'aborted' });
      return;
    }
    const request = options.xhr ? options.xhr() : new XMLHttpRequest();
    const finish = (result: UploadResult): void => {
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      request.abort();
      finish({ kind: 'aborted' });
    };
    request.upload.onprogress = (event) => {
      // An upload whose size the browser cannot tell reports nothing useful.
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    };
    request.onload = () => finish({ kind: 'response', status: request.status, text: request.responseText });
    request.onerror = () => finish({ kind: 'network' });
    request.ontimeout = () => finish({ kind: 'network' });
    request.onabort = () => finish({ kind: 'aborted' });
    request.timeout = options.timeoutMs;
    signal?.addEventListener('abort', onAbort, { once: true });

    const form = new FormData();
    form.append(field, file, file.name);
    request.open('POST', url);
    request.send(form);
  });
}
