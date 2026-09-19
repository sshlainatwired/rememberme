package app.rememberme.journal;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import app.rememberme.journal.notifications.WeeklyNotificationsPlugin;
import app.rememberme.journal.transfer.DocumentTransferPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DocumentTransferPlugin.class);
        registerPlugin(WeeklyNotificationsPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        WeeklyNotificationsPlugin.captureIntent(intent);
    }
}
