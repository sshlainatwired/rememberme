package app.rememberme.journal.transfer;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertThrows;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import org.junit.Test;

/** Host (JVM) behavior tests for bounded SAF stream I/O. */
public class BoundedDocumentIOTest {

    @Test
    public void readEmptyReturnsZeroBytes() throws IOException {
        assertArrayEquals(new byte[0], BoundedDocumentIO.read(new ByteArrayInputStream(new byte[0]), 1024));
    }

    @Test
    public void readExactLimitSucceeds() throws IOException {
        byte[] bytes = new byte[512];
        assertArrayEquals(bytes, BoundedDocumentIO.read(new ByteArrayInputStream(bytes), 512));
    }

    @Test
    public void readOverLimitThrows() {
        assertThrows(IOException.class, () -> BoundedDocumentIO.read(new ByteArrayInputStream(new byte[1025]), 1024));
    }

    @Test
    public void readMidStreamFailurePropagates() {
        InputStream failing = new InputStream() {
            private int remaining = 100;

            @Override
            public int read() throws IOException {
                if (remaining == 0) {
                    throw new IOException("mid-stream failure");
                }
                remaining -= 1;
                return 0;
            }
        };
        assertThrows(IOException.class, () -> BoundedDocumentIO.read(failing, 1024));
    }

    @Test
    public void readNegativeLimitThrows() {
        assertThrows(IOException.class, () -> BoundedDocumentIO.read(new ByteArrayInputStream(new byte[1]), -1));
    }

    @Test
    public void writeWithinLimitSucceeds() throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] bytes = new byte[100];
        BoundedDocumentIO.write(output, bytes, 100);
        assertArrayEquals(bytes, output.toByteArray());
    }

    @Test
    public void writeOverLimitWritesNothing() {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        assertThrows(IOException.class, () -> BoundedDocumentIO.write(output, new byte[101], 100));
        assertArrayEquals(new byte[0], output.toByteArray());
    }

    @Test
    public void writeNegativeLimitThrows() {
        assertThrows(IOException.class, () -> BoundedDocumentIO.write(new ByteArrayOutputStream(), new byte[1], -1));
    }

    @Test
    public void writeMidWriteFailurePropagates() {
        OutputStream failing = new OutputStream() {
            @Override
            public void write(int value) throws IOException {
                throw new IOException("mid-write failure");
            }
        };
        assertThrows(IOException.class, () -> BoundedDocumentIO.write(failing, new byte[10], 100));
    }
}