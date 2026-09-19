package com.getcapacitor.community.database.sqlite.SQLite;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public class KeyProtectionStateTest {

    private static final String SECRET = "test-secret";

    private static class FakeStores implements KeyProtectionState.Stores {

        String disabled;
        String protectedValue;
        String mode;
        String failAt;
        final List<String> calls = new ArrayList<>();

        FakeStores(String mode, String disabled, String protectedValue) {
            this.mode = mode;
            this.disabled = disabled;
            this.protectedValue = protectedValue;
        }

        private void call(String name) throws Exception {
            calls.add(name);
            if (name.equals(failAt)) throw new Exception("injected " + name);
        }

        @Override
        public String readMode() throws Exception {
            call("readMode");
            return mode;
        }

        @Override
        public void writeMode(KeyProtectionState.Mode next) throws Exception {
            call("writeMode:" + next.name());
            mode = next.name();
        }

        @Override
        public String readDisabledSecret() throws Exception {
            call("readDisabled");
            return disabled;
        }

        @Override
        public void writeDisabledSecret(String value) throws Exception {
            call("writeDisabled");
            disabled = value;
        }

        @Override
        public void clearDisabledSecret() throws Exception {
            call("clearDisabled");
            disabled = null;
        }

        @Override
        public String readProtectedSecret() throws Exception {
            call("readProtected");
            return protectedValue;
        }

        @Override
        public void writeProtectedSecret(String value) throws Exception {
            call("writeProtected");
            protectedValue = value;
        }

        @Override
        public void clearProtectedSecret() throws Exception {
            call("clearProtected");
            protectedValue = null;
        }
    }

    @Test
    public void decodeModeTreatsAbsentAsDisabledAndRejectsUnknown() throws Exception {
        assertEquals(KeyProtectionState.Mode.DISABLED, KeyProtectionState.decodeMode(null));
        assertEquals(KeyProtectionState.Mode.DISABLED, KeyProtectionState.decodeMode("DISABLED"));
        assertEquals(KeyProtectionState.Mode.ENABLING, KeyProtectionState.decodeMode("ENABLING"));
        assertEquals(KeyProtectionState.Mode.ENABLED, KeyProtectionState.decodeMode("ENABLED"));
        assertThrows(Exception.class, () -> KeyProtectionState.decodeMode("enabled"));
        assertThrows(Exception.class, () -> KeyProtectionState.decodeMode("BROKEN"));
    }

    @Test
    public void enableVerifiesDestinationBeforeDeletingSourceAndSwitchingAuthority() throws Exception {
        FakeStores stores = new FakeStores("DISABLED", SECRET, null);
        assertEquals(KeyProtectionState.Mode.ENABLED, KeyProtectionState.enable(stores));
        assertEquals("ENABLED", stores.mode);
        assertEquals(null, stores.disabled);
        assertEquals(SECRET, stores.protectedValue);
        assertTrue(stores.calls.indexOf("readProtected") < stores.calls.indexOf("clearDisabled"));
        assertTrue(stores.calls.indexOf("clearDisabled") < stores.calls.indexOf("writeMode:ENABLED"));
    }

    @Test
    public void failedEnablingMarkerChangesNoSecretStore() {
        FakeStores stores = new FakeStores("DISABLED", SECRET, null);
        stores.failAt = "writeMode:ENABLING";
        assertThrows(Exception.class, () -> KeyProtectionState.enable(stores));
        assertEquals("DISABLED", stores.mode);
        assertEquals(SECRET, stores.disabled);
        assertEquals(null, stores.protectedValue);
    }

    @Test
    public void failedProtectedWriteLeavesDisabledCopyAndEnablingRecoveryMarker() {
        FakeStores stores = new FakeStores("DISABLED", SECRET, null);
        stores.failAt = "writeProtected";
        assertThrows(Exception.class, () -> KeyProtectionState.enable(stores));
        assertEquals("ENABLING", stores.mode);
        assertEquals(SECRET, stores.disabled);
    }

    @Test
    public void failedProtectedReadbackNeverDeletesDisabledCopy() {
        FakeStores stores = new FakeStores("DISABLED", SECRET, null);
        stores.failAt = "readProtected";
        assertThrows(Exception.class, () -> KeyProtectionState.enable(stores));
        assertEquals(SECRET, stores.disabled);
        assertTrue(!stores.calls.contains("clearDisabled"));
    }

    @Test
    public void failedDisabledRemovalLeavesBothCopiesForRecovery() {
        FakeStores stores = new FakeStores("DISABLED", SECRET, null);
        stores.failAt = "clearDisabled";
        assertThrows(Exception.class, () -> KeyProtectionState.enable(stores));
        assertEquals("ENABLING", stores.mode);
        assertEquals(SECRET, stores.disabled);
        assertEquals(SECRET, stores.protectedValue);
    }

    @Test
    public void failedEnabledMarkerLeavesProtectedOnlyAndRecoverable() {
        FakeStores stores = new FakeStores("DISABLED", SECRET, null);
        stores.failAt = "writeMode:ENABLED";
        assertThrows(Exception.class, () -> KeyProtectionState.enable(stores));
        assertEquals("ENABLING", stores.mode);
        assertEquals(null, stores.disabled);
        assertEquals(SECRET, stores.protectedValue);
    }

    @Test
    public void recoveryFinishesEqualDuplicateCopies() throws Exception {
        FakeStores stores = new FakeStores("ENABLING", SECRET, SECRET);
        assertEquals(KeyProtectionState.Mode.ENABLED, KeyProtectionState.recoverEnabling(stores));
        assertEquals(null, stores.disabled);
        assertEquals(SECRET, stores.protectedValue);
        assertEquals("ENABLED", stores.mode);
    }

    @Test
    public void recoveryFinishesProtectedOnly() throws Exception {
        FakeStores stores = new FakeStores("ENABLING", null, SECRET);
        assertEquals(KeyProtectionState.Mode.ENABLED, KeyProtectionState.recoverEnabling(stores));
        assertEquals("ENABLED", stores.mode);
    }

    @Test
    public void recoveryRevertsDisabledOnly() throws Exception {
        FakeStores stores = new FakeStores("ENABLING", SECRET, null);
        assertEquals(KeyProtectionState.Mode.DISABLED, KeyProtectionState.recoverEnabling(stores));
        assertEquals("DISABLED", stores.mode);
        assertEquals(SECRET, stores.disabled);
    }

    @Test
    public void recoveryRejectsMissingAndDifferingCopiesWithoutDeletingEither() {
        FakeStores missing = new FakeStores("ENABLING", null, null);
        assertThrows(Exception.class, () -> KeyProtectionState.recoverEnabling(missing));
        assertTrue(!missing.calls.contains("clearDisabled"));
        assertTrue(!missing.calls.contains("clearProtected"));

        FakeStores mismatch = new FakeStores("ENABLING", "one", "two");
        assertThrows(Exception.class, () -> KeyProtectionState.recoverEnabling(mismatch));
        assertEquals("one", mismatch.disabled);
        assertEquals("two", mismatch.protectedValue);
    }

    @Test
    public void disableVerifiesDisabledCopyBeforeSwitchingAuthority() throws Exception {
        FakeStores stores = new FakeStores("ENABLED", null, SECRET);
        assertEquals(KeyProtectionState.Mode.DISABLED, KeyProtectionState.disable(stores));
        assertEquals("DISABLED", stores.mode);
        assertEquals(SECRET, stores.disabled);
        assertEquals(null, stores.protectedValue);
        assertTrue(stores.calls.indexOf("readDisabled") < stores.calls.indexOf("writeMode:DISABLED"));
        assertTrue(stores.calls.indexOf("writeMode:DISABLED") < stores.calls.indexOf("clearProtected"));
    }

    @Test
    public void failedDisabledWriteOrReadbackNeverChangesAuthorityOrDeletesProtectedCopy() {
        FakeStores writeFailure = new FakeStores("ENABLED", null, SECRET);
        writeFailure.failAt = "writeDisabled";
        assertThrows(Exception.class, () -> KeyProtectionState.disable(writeFailure));
        assertEquals("ENABLED", writeFailure.mode);
        assertEquals(SECRET, writeFailure.protectedValue);

        FakeStores readFailure = new FakeStores("ENABLED", null, SECRET);
        readFailure.failAt = "readDisabled";
        assertThrows(Exception.class, () -> KeyProtectionState.disable(readFailure));
        assertEquals("ENABLED", readFailure.mode);
        assertEquals(SECRET, readFailure.protectedValue);
        assertTrue(!readFailure.calls.contains("clearProtected"));
    }

    @Test
    public void failedDisabledMarkerLeavesBothVerifiedCopiesAndEnabledAuthority() {
        FakeStores stores = new FakeStores("ENABLED", null, SECRET);
        stores.failAt = "writeMode:DISABLED";
        assertThrows(Exception.class, () -> KeyProtectionState.disable(stores));
        assertEquals("ENABLED", stores.mode);
        assertEquals(SECRET, stores.disabled);
        assertEquals(SECRET, stores.protectedValue);
        assertTrue(!stores.calls.contains("clearProtected"));
    }

    @Test
    public void failedProtectedCleanupOccursOnlyAfterDisabledAuthorityIsDurable() {
        FakeStores stores = new FakeStores("ENABLED", null, SECRET);
        stores.failAt = "clearProtected";
        assertThrows(Exception.class, () -> KeyProtectionState.disable(stores));
        assertEquals("DISABLED", stores.mode);
        assertEquals(SECRET, stores.disabled);
        assertEquals(SECRET, stores.protectedValue);
    }

    @Test
    public void missingSourceAndMismatchedReadbackAlwaysFailClosed() {
        assertThrows(
            Exception.class,
            () -> KeyProtectionState.enable(new FakeStores("DISABLED", null, null))
        );
        assertThrows(
            Exception.class,
            () -> KeyProtectionState.disable(new FakeStores("ENABLED", null, null))
        );

        FakeStores mismatch = new FakeStores("DISABLED", SECRET, null) {
            @Override
            public String readProtectedSecret() throws Exception {
                super.readProtectedSecret();
                return "different";
            }
        };
        assertThrows(Exception.class, () -> KeyProtectionState.enable(mismatch));
        assertEquals(SECRET, mismatch.disabled);
    }
}
