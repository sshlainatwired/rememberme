package app.rememberme.journal.transfer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Bounded document stream I/O.
 *
 * Streams through {@link InputStream}/{@link OutputStream} while enforcing a
 * caller-supplied byte limit, so arbitrarily large or hostile documents can
 * never be fully buffered in memory. Reads accumulate into one byte array
 * (the phase's whole-file transfer model caps transfers at 16 MiB).
 */
final class BoundedDocumentIO {

    private BoundedDocumentIO() {}

    /** Read at most {@code maxBytes} bytes; throws before buffering more. */
    static byte[] read(InputStream input, int maxBytes) throws IOException {
        if (maxBytes < 0) {
            throw new IOException("maxBytes must be non-negative");
        }
        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int total = 0;
        int count;
        while ((count = input.read(chunk)) != -1) {
            total += count;
            if (total > maxBytes) {
                throw new IOException("document exceeds byte limit");
            }
            buffer.write(chunk, 0, count);
        }
        input.close();
        return buffer.toByteArray();
    }

    /** Write {@code bytes} only when it fits {@code maxBytes}; no partial over-limit write. */
    static void write(OutputStream output, byte[] bytes, int maxBytes) throws IOException {
        if (maxBytes < 0) {
            throw new IOException("maxBytes must be non-negative");
        }
        if (bytes.length > maxBytes) {
            output.close();
            throw new IOException("document exceeds byte limit");
        }
        output.write(bytes);
        output.close();
    }
}