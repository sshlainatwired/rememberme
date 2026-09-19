package app.rememberme.journal;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * Local unit test (runs on the dev machine / host JVM).
 *
 * Guards the single most identity-critical configuration invariant: the
 * generated BuildConfig APPLICATION_ID must equal the committed applicationId
 * logged in ADR-0002. Renaming the package (applicationId / namespace) would
 * treat the app as a new install on device and orphan existing data, so this
 * value must not drift.
 */
public class ApplicationIdTest {

    @Test
    public void applicationId_matchesCommittedId() {
        assertEquals("app.rememberme.journal", BuildConfig.APPLICATION_ID);
    }
}
