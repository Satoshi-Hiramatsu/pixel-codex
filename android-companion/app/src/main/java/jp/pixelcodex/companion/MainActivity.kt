package jp.pixelcodex.companion

import android.content.SharedPreferences
import android.graphics.BitmapFactory
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.util.UUID

private enum class CompanionTab { CONSOLE, PREVIEW, SETTINGS }

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
                CompanionApp(
                    client = client,
                    preferences = preferences,
                    initialRelayUrl = launchRelayUrl ?: preferences.getString("relayUrl", "") ?: "",
                    initialHostId = launchHostId ?: preferences.getString("hostId", "") ?: "",
                    initialPairAddress = preferences.getString("pairAddress", "") ?: "",
                    autoConnect = autoConnect || preferences.getBoolean("paired", false),
                )
            }
        }
    }
}

@Composable
private fun CompanionApp(
    client: RemoteClient,
    preferences: SharedPreferences,
    initialRelayUrl: String,
    initialHostId: String,
    initialPairAddress: String,
    autoConnect: Boolean,
) {
    val state by client.state.collectAsStateWithLifecycle()
    val pairingClient = remember { PairingClient() }
    val relayFinder = remember { RelayFinder() }
    var searchBusy by remember { mutableStateOf(false) }
    var autoSearchDone by remember { mutableStateOf(false) }
    var relayUrl by remember { mutableStateOf(initialRelayUrl) }
    var hostId by remember { mutableStateOf(initialHostId) }
    var pairAddress by remember { mutableStateOf(initialPairAddress) }
    var pairCode by remember { mutableStateOf("") }
    var pairBusy by remember { mutableStateOf(false) }
    var pairMessage by remember { mutableStateOf("") }
    var manualOpen by remember { mutableStateOf(false) }
    var instruction by remember { mutableStateOf("") }
    var previewViewport by remember { mutableStateOf("mobile") }
    var tab by remember {
        mutableStateOf(if (initialRelayUrl.isBlank()) CompanionTab.SETTINGS else CompanionTab.CONSOLE)
    }
    val online = state.phase == ConnectionPhase.ONLINE
    val busy = online || state.phase == ConnectionPhase.CONNECTING

    fun saveConnection(url: String, id: String) {
        preferences.edit().putString("relayUrl", url).putString("hostId", id).apply()
    }

    fun applyConnection(url: String, id: String, note: String) {
        relayUrl = url
        hostId = id
        pairMessage = note
        saveConnection(url, id)
        preferences.edit().putBoolean("paired", true).apply()
        client.connect(url, id)
        tab = CompanionTab.CONSOLE
    }

    fun runPairing(address: String, code: String) {
        pairBusy = true
        pairMessage = "PCを探しています…"
        pairingClient.pair(address, code) { outcome ->
            pairBusy = false
            when (outcome) {
                is PairingOutcome.Success -> {
                    pairCode = ""
                    preferences.edit().putString("pairAddress", address.substringBefore(':')).apply()
                    applyConnection(outcome.relayUrl, outcome.hostId, "ペアリングしました。接続します")
                }
                is PairingOutcome.Failure -> pairMessage = outcome.message
            }
        }
    }

    /**
     * PCのIPが変わっても、保存済みのトークンとHost IDで探し直します。ノートPCで
     * ネットワークが変わるたびにペアリングし直さずに済むようにするためです。
     */
    fun searchForPc(announce: Boolean) {
        if (searchBusy) return
        if (relayUrl.isBlank() || hostId.isBlank()) {
            if (announce) pairMessage = "先にペアリングしてください"
            return
        }
        searchBusy = true
        if (announce) pairMessage = "同じネットワーク上でPCを探しています…"
        relayFinder.find(hostId, relayHostOf(relayUrl), relayPortOf(relayUrl)) { found, note ->
            searchBusy = false
            pairMessage = note
            if (found == null) return@find
            val updated = relayUrlWithHost(relayUrl, found.host, found.port)
            if (updated == null) {
                pairMessage = "接続先を組み立て直せませんでした"
                return@find
            }
            pairAddress = found.host
            preferences.edit().putString("pairAddress", found.host).apply()
            applyConnection(updated, hostId, "PCが${found.host}に移動していました。接続します")
        }
    }

    // 保存済みのアドレスが古くなっていたら、一度だけ黙って探し直します。
    LaunchedEffect(state.phase) {
        if (state.phase == ConnectionPhase.ONLINE) {
            autoSearchDone = false
            return@LaunchedEffect
        }
        if (state.phase == ConnectionPhase.ERROR && !autoSearchDone && relayUrl.isNotBlank()) {
            autoSearchDone = true
            searchForPc(announce = false)
        }
    }

    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents
        if (contents == null) {
            pairMessage = "読み取りを中止しました"
            return@rememberLauncherForActivityResult
        }
        when (val scanned = parsePairingQr(contents)) {
            is ScannedConnection.Lan -> {
                pairAddress = scanned.host
                pairCode = scanned.code
                runPairing("${scanned.host}:${scanned.port}", scanned.code)
            }
            is ScannedConnection.Url ->
                // ループバックはPC自身を指すため、読み取っても端末からは届きません。
                if (isLoopbackUrl(scanned.relayUrl)) {
                    pairMessage = "このQRはPC自身のアドレス（127.0.0.1）を指しているため接続できません。" +
                        "PCで「ケーブルなしでペアリング」を押し、コードが出る方のQRを読み取ってください"
                } else {
                    applyConnection(scanned.relayUrl, scanned.hostId, "QRから接続設定を読み込みました")
                }
            null -> pairMessage = "Pixel CodexのQRではありません"
        }
    }

    // 撮影対象は見た目タブを開いたときだけ取りに行きます。開くまでは何も要求しません。
    LaunchedEffect(tab, state.phase, state.preview.sourcesLoaded) {
        if (tab == CompanionTab.PREVIEW
            && state.phase == ConnectionPhase.ONLINE
            && !state.preview.sourcesLoaded
        ) {
            client.requestPreviewSources()
        }
    }

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

            TabSwitch(tab = tab, onSelect = { tab = it })
            StatusCard(state)

            when (tab) {
                CompanionTab.CONSOLE -> ConsoleTab(
                    state = state,
                    online = online,
                    instruction = instruction,
                    onInstructionChange = { instruction = it },
                    onSend = { if (client.sendInstruction(instruction)) instruction = "" },
                    onOpenSettings = { tab = CompanionTab.SETTINGS },
                    onDecideApproval = { requestId, accept -> client.sendApproval(requestId, accept) },
                    onAnswerQuestion = { requestId, answers ->
                        client.sendQuestionAnswers(requestId, answers)
                    },
                )

                CompanionTab.PREVIEW -> PreviewTab(
                    preview = state.preview,
                    online = online,
                    viewport = previewViewport,
                    onViewportChange = { previewViewport = it },
                    onRefreshSources = { client.requestPreviewSources() },
                    onCapture = { sourceId -> client.requestPreview(sourceId, previewViewport) },
                    onLoadImage = { url, onDone -> client.fetchPreview(url, onDone) },
                )

                CompanionTab.SETTINGS -> SettingsTab(
                    busy = busy,
                    pairAddress = pairAddress,
                    onPairAddressChange = { pairAddress = it },
                    pairCode = pairCode,
                    onPairCodeChange = { pairCode = it },
                    pairBusy = pairBusy,
                    pairMessage = pairMessage,
                    onScan = {
                        pairMessage = ""
                        scanLauncher.launch(
                            ScanOptions()
                                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                                .setPrompt("PCの画面のQRコードを枠に合わせてください")
                                .setBeepEnabled(false)
                                .setOrientationLocked(false),
                        )
                    },
                    onPair = { runPairing(pairAddress, pairCode) },
                    relayUrl = relayUrl,
                    onRelayUrlChange = { relayUrl = it },
                    hostId = hostId,
                    onHostIdChange = { hostId = it },
                    manualOpen = manualOpen,
                    onToggleManual = { manualOpen = !manualOpen },
                    onConnect = {
                        saveConnection(relayUrl.trim(), hostId.trim())
                        client.connect(relayUrl, hostId)
                        tab = CompanionTab.CONSOLE
                    },
                    onDisconnect = {
                        client.disconnect()
                        pairMessage = "切断しました"
                    },
                    onReconnectSaved = {
                        val savedUrl = preferences.getString("relayUrl", "").orEmpty()
                        val savedHostId = preferences.getString("hostId", "").orEmpty()
                        if (savedUrl.isBlank() || savedHostId.isBlank()) {
                            pairMessage = "保存された接続設定がありません"
                        } else {
                            relayUrl = savedUrl
                            hostId = savedHostId
                            pairMessage = "前回の設定で接続します"
                            client.connect(savedUrl, savedHostId)
                            tab = CompanionTab.CONSOLE
                        }
                    },
                    hasSavedConnection = preferences.getString("relayUrl", "").isNullOrBlank().not(),
                    searchBusy = searchBusy,
                    onSearchForPc = { searchForPc(announce = true) },
                )
            }
        }
    }
}

@Composable
private fun TabSwitch(tab: CompanionTab, onSelect: (CompanionTab) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TabButton("Codex", tab == CompanionTab.CONSOLE, Modifier.weight(1f)) {
            onSelect(CompanionTab.CONSOLE)
        }
        TabButton("見た目", tab == CompanionTab.PREVIEW, Modifier.weight(1f)) {
            onSelect(CompanionTab.PREVIEW)
        }
        TabButton("通信設定", tab == CompanionTab.SETTINGS, Modifier.weight(1f)) {
            onSelect(CompanionTab.SETTINGS)
        }
    }
}

@Composable
private fun TabButton(label: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    if (selected) {
        Button(modifier = modifier, onClick = onClick) { Text(label, fontWeight = FontWeight.Black) }
    } else {
        OutlinedButton(modifier = modifier, onClick = onClick) { Text(label) }
    }
}

@Composable
private fun ConsoleTab(
    state: RemoteUiState,
    online: Boolean,
    instruction: String,
    onInstructionChange: (String) -> Unit,
    onSend: () -> Unit,
    onOpenSettings: () -> Unit,
    onDecideApproval: (String, Boolean) -> Unit,
    onAnswerQuestion: (String, Map<String, String>) -> Unit,
) {
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
                onValueChange = { onInstructionChange(it.take(4_000)) },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(132.dp),
                label = { Text("Codexへの指示") },
                enabled = online,
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("${instruction.length}/4000", style = MaterialTheme.typography.labelSmall)
                Button(enabled = online && instruction.isNotBlank(), onClick = onSend) { Text("送信") }
            }
            if (state.lastCommandResult.isNotEmpty()) {
                Text(state.lastCommandResult, color = Color(0xFFF0BD55), fontWeight = FontWeight.Bold)
            }
            if (!online) {
                Text(
                    "PCに接続していないため送信できません。",
                    style = MaterialTheme.typography.bodySmall,
                    color = Color(0xFFE1775B),
                )
                TextButton(onClick = onOpenSettings) { Text("通信設定を開く") }
            }
        }
    }

    state.approval?.let { approval ->
        ApprovalCard(approval = approval, enabled = online, onDecide = onDecideApproval)
    }

    state.question?.let { question ->
        QuestionCard(request = question, enabled = online, onAnswer = onAnswerQuestion)
    }

    // 可否を端末へ渡さない設定のときは、待っていることだけ知らせます。
    if ((state.approvalPending && state.approval == null)
        || (state.questionPending && state.question == null)
    ) {
        Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF6B332C))) {
            Column(Modifier.padding(14.dp)) {
                Text("PCでの操作が必要です", fontWeight = FontWeight.Black)
                Spacer(Modifier.height(5.dp))
                if (state.approvalPending && state.approval == null) Text("承認待ちがあります")
                if (state.questionPending && state.question == null) Text("Codexから質問があります")
                Text(
                    "PCの通信室で「承認の可否と質問への回答をスマートフォンから行う」をONにすると、ここで操作できます。",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

@Composable
private fun ApprovalCard(
    approval: ApprovalRequest,
    enabled: Boolean,
    onDecide: (String, Boolean) -> Unit,
) {
    val riskColor = when (approval.risk) {
        "high" -> Color(0xFFE1775B)
        "low" -> Color(0xFF70CA8A)
        else -> Color(0xFFF0BD55)
    }
    Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF5A2F28))) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(approval.title, fontWeight = FontWeight.Black)
            if (approval.riskLabel.isNotEmpty()) {
                Text(approval.riskLabel, color = riskColor, fontWeight = FontWeight.Bold)
            }
            if (approval.headline.isNotEmpty()) Text(approval.headline)
            approval.bullets.forEach { bullet ->
                Text("・$bullet", style = MaterialTheme.typography.bodySmall)
            }
            if (approval.command.isNotEmpty()) {
                Text("コマンド", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.secondary)
                Text(approval.command, style = MaterialTheme.typography.bodySmall)
            }
            if (approval.cwd.isNotEmpty()) {
                Text("場所：${approval.cwd}", style = MaterialTheme.typography.bodySmall)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    modifier = Modifier.weight(1f),
                    enabled = enabled,
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF8A979B)),
                    onClick = { onDecide(approval.requestId, false) },
                ) { Text("拒否", color = Color(0xFF20282B)) }
                Button(
                    modifier = Modifier.weight(1f),
                    enabled = enabled,
                    onClick = { onDecide(approval.requestId, true) },
                ) { Text("承認する", fontWeight = FontWeight.Black) }
            }
        }
    }
}

@Composable
private fun QuestionCard(
    request: QuestionRequest,
    enabled: Boolean,
    onAnswer: (String, Map<String, String>) -> Unit,
) {
    val answers = remember(request.requestId) {
        mutableStateMapOf<String, String>().apply {
            request.questions.forEach { put(it.id, "") }
        }
    }
    val complete = request.questions.all { answers[it.id]?.isNotBlank() == true }

    Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF33465C))) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Codexからの質問", fontWeight = FontWeight.Black)
            request.questions.forEach { question ->
                Text(question.header, fontWeight = FontWeight.Bold)
                Text(question.question, style = MaterialTheme.typography.bodySmall)
                if (question.options.isNotEmpty()) {
                    Text(
                        "候補：${question.options.joinToString("／")}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.secondary,
                    )
                }
                OutlinedTextField(
                    value = answers[question.id].orEmpty(),
                    onValueChange = { answers[question.id] = it.take(1_000) },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("回答") },
                    enabled = enabled,
                )
            }
            Button(
                modifier = Modifier.fillMaxWidth(),
                enabled = enabled && complete,
                onClick = { onAnswer(request.requestId, answers.toMap()) },
            ) { Text("回答を送る") }
        }
    }
}

@Composable
private fun SettingsTab(
    busy: Boolean,
    pairAddress: String,
    onPairAddressChange: (String) -> Unit,
    pairCode: String,
    onPairCodeChange: (String) -> Unit,
    pairBusy: Boolean,
    pairMessage: String,
    onScan: () -> Unit,
    onPair: () -> Unit,
    relayUrl: String,
    onRelayUrlChange: (String) -> Unit,
    hostId: String,
    onHostIdChange: (String) -> Unit,
    manualOpen: Boolean,
    onToggleManual: () -> Unit,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
    onReconnectSaved: () -> Unit,
    hasSavedConnection: Boolean,
    searchBusy: Boolean,
    onSearchForPc: () -> Unit,
) {
    Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF3D2C50))) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("PCとペアリング", fontWeight = FontWeight.Bold)
            Text(
                "PCの通信室でQRを表示し、それを読み取れば一度で接続できます。外部Relayを使う設定も同じ手順です。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.secondary,
            )
            Button(modifier = Modifier.fillMaxWidth(), enabled = !pairBusy, onClick = onScan) {
                Text("QRで読み取る", fontWeight = FontWeight.Black)
            }
            Text(
                "カメラが使えないときは手入力してください。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.secondary,
            )
            OutlinedTextField(
                value = pairAddress,
                onValueChange = { onPairAddressChange(it.trim()) },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("PCのアドレス") },
                placeholder = { Text("192.168.68.59") },
                singleLine = true,
            )
            OutlinedTextField(
                value = pairCode,
                onValueChange = { onPairCodeChange(it.filter(Char::isDigit).take(PairingClient.codeLength)) },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("ペアリングコード（6桁）") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            )
            OutlinedButton(
                modifier = Modifier.fillMaxWidth(),
                enabled = !pairBusy && pairAddress.isNotBlank() && pairCode.length == PairingClient.codeLength,
                onClick = onPair,
            ) {
                Text(if (pairBusy) "ペアリング中…" else "コードでペアリング")
            }
            if (pairMessage.isNotEmpty()) {
                Text(pairMessage, color = Color(0xFFF0BD55), style = MaterialTheme.typography.bodySmall)
            }
        }
    }

    Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF183B59))) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("接続", fontWeight = FontWeight.Bold)
            Text(
                "現在の接続先：${describeRelayUrl(relayUrl)}",
                style = MaterialTheme.typography.bodySmall,
                color = if (isLoopbackUrl(relayUrl)) Color(0xFFE1775B) else MaterialTheme.colorScheme.secondary,
            )
            if (isLoopbackUrl(relayUrl)) {
                Text(
                    "PC自身のアドレスが保存されています。USB接続時以外は届きません。",
                    style = MaterialTheme.typography.labelSmall,
                    color = Color(0xFFE1775B),
                )
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    modifier = Modifier.weight(1f),
                    enabled = !busy && relayUrl.isNotBlank() && hostId.isNotBlank(),
                    onClick = onConnect,
                ) { Text("PCへ接続") }
                Button(
                    modifier = Modifier.weight(1f),
                    enabled = busy,
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFA84C35)),
                    onClick = onDisconnect,
                ) { Text("切断", color = Color(0xFFFFF2CE)) }
            }
            OutlinedButton(
                modifier = Modifier.fillMaxWidth(),
                enabled = !busy && hasSavedConnection,
                onClick = onReconnectSaved,
            ) { Text("前回の設定で再接続") }
            OutlinedButton(
                modifier = Modifier.fillMaxWidth(),
                enabled = !searchBusy && hasSavedConnection,
                onClick = onSearchForPc,
            ) { Text(if (searchBusy) "PCを探しています…" else "PCを探し直す（IPが変わったとき）") }
            Text(
                "PCのIPアドレスが変わっても、同じネットワークにいれば探し直せます。ペアリングのやり直しは不要です。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.secondary,
            )
            TextButton(onClick = onToggleManual) {
                Text(if (manualOpen) "手動設定を隠す" else "手動設定を表示")
            }
            if (manualOpen) {
                OutlinedTextField(
                    value = relayUrl,
                    onValueChange = onRelayUrlChange,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Relay URL") },
                    placeholder = { Text("wss://relay.example.com/relay") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                )
                OutlinedTextField(
                    value = hostId,
                    onValueChange = onHostIdChange,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("PCのHost ID") },
                    singleLine = true,
                )
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
private fun PreviewTab(
    preview: PreviewState,
    online: Boolean,
    viewport: String,
    onViewportChange: (String) -> Unit,
    onRefreshSources: () -> Unit,
    onCapture: (String) -> Unit,
    onLoadImage: (String, (ByteArray?) -> Unit) -> Unit,
) {
    var bitmap by remember { mutableStateOf<ImageBitmap?>(null) }
    var loadError by remember { mutableStateOf("") }

    // 届いた在り処から実物を取りに行きます。要求したときだけ通信が起きる経路です。
    LaunchedEffect(preview.image?.previewId) {
        val image = preview.image
        bitmap = null
        loadError = ""
        if (image == null) return@LaunchedEffect
        onLoadImage(image.url) { data ->
            val decoded = data?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
            if (decoded == null) loadError = "画像を受け取れませんでした" else bitmap = decoded.asImageBitmap()
        }
    }

    Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF203F38))) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("いまの見た目", fontWeight = FontWeight.Black)
            Text(
                "選んだものをPCがその場で撮って送ります。自動では送られません。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.secondary,
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TabButton("スマホ幅", viewport == "mobile", Modifier.weight(1f)) { onViewportChange("mobile") }
                TabButton("PC幅", viewport == "desktop", Modifier.weight(1f)) { onViewportChange("desktop") }
            }
            OutlinedButton(
                modifier = Modifier.fillMaxWidth(),
                enabled = online,
                onClick = onRefreshSources,
            ) { Text("対象を読み込み直す") }

            if (preview.busy) Text("PCで撮影中…", color = MaterialTheme.colorScheme.primary)
            if (preview.message.isNotBlank()) {
                Text(preview.message, style = MaterialTheme.typography.bodySmall)
            }
            if (!online) {
                Text("PCがオフラインです", style = MaterialTheme.typography.bodySmall)
            } else if (preview.sourcesLoaded && preview.sources.isEmpty() && preview.message.isBlank()) {
                Text("撮影できる対象がありません", style = MaterialTheme.typography.bodySmall)
            }

            preview.sources.forEach { source ->
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    enabled = online && !preview.busy,
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2F6F62)),
                    onClick = { onCapture(source.id) },
                ) {
                    Text("${previewSourceMark(source.kind)} ${source.label}", maxLines = 2)
                }
            }
        }
    }

    val image = preview.image
    if (image != null) {
        Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF16323F))) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val shown = bitmap
                if (shown != null) {
                    Image(
                        bitmap = shown,
                        contentDescription = "PCの画面",
                        modifier = Modifier.fillMaxWidth(),
                        contentScale = ContentScale.FillWidth,
                    )
                } else if (loadError.isNotBlank()) {
                    Text(loadError)
                } else {
                    Text("画像を受け取っています…", color = MaterialTheme.colorScheme.secondary)
                }
                Text(
                    "${image.width}×${image.height} / ${image.bytes / 1024}KB",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.secondary,
                )
            }
        }
    }
}

private fun previewSourceMark(kind: String): String = when (kind) {
    "url" -> "WEB"
    "file" -> "FILE"
    else -> "WINDOW"
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
