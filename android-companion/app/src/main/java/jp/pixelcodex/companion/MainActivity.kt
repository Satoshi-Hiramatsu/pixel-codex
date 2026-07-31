package jp.pixelcodex.companion

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.util.UUID

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val preferences = getSharedPreferences("pixel-codex-remote", MODE_PRIVATE)
        val deviceId = preferences.getString("deviceId", null) ?: UUID.randomUUID().toString().also {
            preferences.edit().putString("deviceId", it).apply()
        }
        val launchRelayUrl = intent.getStringExtra("relayUrl")
        val launchHostId = intent.getStringExtra("hostId")
        val autoConnect = intent.getBooleanExtra("autoConnect", false)
        setContent {
            val client = remember { RemoteClient(deviceId) }
            DisposableEffect(Unit) { onDispose(client::close) }
            PixelCodexTheme {
                CompanionScreen(
                    client = client,
                    initialRelayUrl = launchRelayUrl ?: preferences.getString("relayUrl", "") ?: "",
                    initialHostId = launchHostId ?: preferences.getString("hostId", "") ?: "",
                    autoConnect = autoConnect,
                    saveConnection = { relayUrl, hostId ->
                        preferences.edit()
                            .putString("relayUrl", relayUrl)
                            .putString("hostId", hostId)
                            .apply()
                    },
                )
            }
        }
    }
}

@Composable
private fun CompanionScreen(
    client: RemoteClient,
    initialRelayUrl: String,
    initialHostId: String,
    autoConnect: Boolean,
    saveConnection: (String, String) -> Unit,
) {
    val state by client.state.collectAsStateWithLifecycle()
    var relayUrl by remember { mutableStateOf(initialRelayUrl) }
    var hostId by remember { mutableStateOf(initialHostId) }
    var instruction by remember { mutableStateOf("") }
    val online = state.phase == ConnectionPhase.ONLINE

    LaunchedEffect(autoConnect, initialRelayUrl, initialHostId) {
        if (autoConnect && initialRelayUrl.isNotBlank() && initialHostId.isNotBlank()) {
            saveConnection(initialRelayUrl, initialHostId)
            client.connect(initialRelayUrl, initialHostId)
        }
    }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .verticalScroll(rememberScrollState())
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("PIXEL CODEX", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Black)
            Text("Android Companion", color = MaterialTheme.colorScheme.secondary)

            StatusCard(state)

            Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF183B59))) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("接続設定", fontWeight = FontWeight.Bold)
                    OutlinedTextField(
                        value = relayUrl,
                        onValueChange = { relayUrl = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Relay URL") },
                        placeholder = { Text("wss://relay.example.com/relay") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                    )
                    OutlinedTextField(
                        value = hostId,
                        onValueChange = { hostId = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("PCのHost ID") },
                        singleLine = true,
                    )
                    Button(
                        modifier = Modifier.fillMaxWidth(),
                        onClick = {
                            if (online || state.phase == ConnectionPhase.CONNECTING) {
                                client.disconnect()
                            } else {
                                saveConnection(relayUrl.trim(), hostId.trim())
                                client.connect(relayUrl, hostId)
                            }
                        },
                    ) {
                        Text(if (online || state.phase == ConnectionPhase.CONNECTING) "切断" else "PCへ接続")
                    }
                }
            }

            Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF203F38))) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("新規・追加指示", fontWeight = FontWeight.Bold)
                    Text(
                        "PCが待機中ならすぐ開始し、作業中なら待ち行列へ入ります。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.secondary,
                    )
                    OutlinedTextField(
                        value = instruction,
                        onValueChange = { instruction = it.take(4_000) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(132.dp),
                        label = { Text("Codexへの指示") },
                        enabled = online,
                    )
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("${instruction.length}/4000", style = MaterialTheme.typography.labelSmall)
                        Button(
                            enabled = online && instruction.isNotBlank(),
                            onClick = {
                                if (client.sendInstruction(instruction)) instruction = ""
                            },
                        ) { Text("送信") }
                    }
                    if (state.lastCommandResult.isNotEmpty()) {
                        Text(state.lastCommandResult, color = Color(0xFFF0BD55), fontWeight = FontWeight.Bold)
                    }
                }
            }

            if (state.approvalPending || state.questionPending) {
                Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF6B332C))) {
                    Column(Modifier.padding(14.dp)) {
                        Text("PCでの操作が必要です", fontWeight = FontWeight.Black)
                        Spacer(Modifier.height(5.dp))
                        if (state.approvalPending) Text("承認待ちがあります")
                        if (state.questionPending) Text("Codexから質問があります")
                        Text("初期版では承認と回答をPCで行ってください。", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusCard(state: RemoteUiState) {
    val statusColor = when (state.phase) {
        ConnectionPhase.ONLINE -> Color(0xFF70CA8A)
        ConnectionPhase.CONNECTING -> Color(0xFFF0BD55)
        ConnectionPhase.ERROR -> Color(0xFFE1775B)
        ConnectionPhase.OFFLINE -> Color(0xFF8A979B)
    }
    Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF172F3E))) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(state.status, color = statusColor, fontWeight = FontWeight.Black)
            Text("作業フォルダ：${state.workspace.ifEmpty { "未選択" }}")
            Text("統括責任者：${state.rootName.ifEmpty { "スレッド未作成" }}")
            if (state.rootStatus.isNotEmpty()) Text("状態：${state.rootStatus}")
            Text("待機指示：${state.pendingInstructions}件")
            if (state.latestMessage.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                Text("最新メッセージ", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.secondary)
                Text(state.latestMessage, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun PixelCodexTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Color(0xFFF0BD55),
            secondary = Color(0xFF8FC7BD),
            background = Color(0xFF10283A),
            surface = Color(0xFF172F3E),
        ),
        content = content,
    )
}
