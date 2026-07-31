package jp.pixelcodex.companion

import android.os.Handler
import android.os.Looper
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

enum class ConnectionPhase { OFFLINE, CONNECTING, ONLINE, ERROR }

data class RemoteUiState(
    val phase: ConnectionPhase = ConnectionPhase.OFFLINE,
    val status: String = "未接続",
    val workspace: String = "",
    val rootName: String = "",
    val rootStatus: String = "",
    val latestMessage: String = "",
    val pendingInstructions: Int = 0,
    val approvalPending: Boolean = false,
    val questionPending: Boolean = false,
    val lastCommandResult: String = "",
)

class RemoteClient(private val deviceId: String) {
    private val httpClient = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .build()
    private val mutableState = MutableStateFlow(RemoteUiState())
    val state: StateFlow<RemoteUiState> = mutableState.asStateFlow()
    private var webSocket: WebSocket? = null
    private var hostId: String = ""
    private var relayUrl: String = ""
    private var shouldReconnect = false
    private var connectionGeneration = 0
    private val reconnectHandler = Handler(Looper.getMainLooper())

    fun connect(relayUrl: String, targetHostId: String) {
        disconnect()
        val rawUrl = relayUrl.trim()
        val url = if (rawUrl.startsWith("https://")) {
            "wss://${rawUrl.removePrefix("https://")}"
        } else {
            rawUrl
        }
        val id = targetHostId.trim()
        if (url.isEmpty() || id.isEmpty()) {
            mutableState.value = RemoteUiState(ConnectionPhase.ERROR, "Relay URLとHost IDを入力してください")
            return
        }
        val secure = url.startsWith("wss://")
        val emulatorDev = url.startsWith("ws://10.0.2.2")
            || url.startsWith("ws://127.0.0.1")
            || url.startsWith("ws://localhost")
        if (!secure && !emulatorDev) {
            mutableState.value = RemoteUiState(ConnectionPhase.ERROR, "本番接続にはwss://が必要です")
            return
        }
        hostId = id
        this.relayUrl = url
        shouldReconnect = true
        val generation = connectionGeneration
        mutableState.value = RemoteUiState(ConnectionPhase.CONNECTING, "Relayへ接続中")
        webSocket = httpClient.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (generation != connectionGeneration) return
                    mutableState.value = mutableState.value.copy(
                        phase = ConnectionPhase.ONLINE,
                        status = "PCを確認中",
                    )
                    webSocket.send(envelope("device.hello", JSONObject().put("deviceId", deviceId)))
                    webSocket.send(envelope("state.snapshot.request", JSONObject()))
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (generation != connectionGeneration) return
                    receive(text)
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (generation != connectionGeneration) return
                    mutableState.value = mutableState.value.copy(
                        phase = ConnectionPhase.OFFLINE,
                        status = "切断されました",
                    )
                    scheduleReconnect()
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    if (generation != connectionGeneration) return
                    mutableState.value = mutableState.value.copy(
                        phase = ConnectionPhase.ERROR,
                        status = t.message ?: "接続できませんでした",
                    )
                    scheduleReconnect()
                }
            },
        )
    }

    fun disconnect() {
        connectionGeneration += 1
        shouldReconnect = false
        reconnectHandler.removeCallbacksAndMessages(null)
        webSocket?.close(1000, "user disconnected")
        webSocket = null
        mutableState.value = RemoteUiState()
    }

    fun sendInstruction(text: String): Boolean {
        val instruction = text.trim()
        val socket = webSocket ?: return false
        if (mutableState.value.phase != ConnectionPhase.ONLINE || instruction.isEmpty()) return false
        val payload = JSONObject()
            .put("deviceId", deviceId)
            .put("text", instruction.take(4_000))
        val sent = socket.send(envelope("instruction.submit", payload))
        if (sent) mutableState.value = mutableState.value.copy(lastCommandResult = "PCへ送信中")
        return sent
    }

    fun close() {
        disconnect()
        httpClient.dispatcher.executorService.shutdown()
        httpClient.connectionPool.evictAll()
    }

    private fun receive(text: String) {
        val message = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (message.optString("type")) {
            "host.status" -> {
                val online = message.optJSONObject("payload")?.optBoolean("online") == true
                mutableState.value = mutableState.value.copy(
                    phase = if (online) ConnectionPhase.ONLINE else ConnectionPhase.OFFLINE,
                    status = if (online) "PCオンライン" else "PCオフライン",
                )
            }
            "state.snapshot" -> applySnapshot(message.optJSONObject("payload") ?: return)
            "command.acknowledged" -> {
                val payload = message.optJSONObject("payload") ?: return
                val outcome = payload.optString("outcome")
                val detail = payload.optString("detail")
                mutableState.value = mutableState.value.copy(
                    lastCommandResult = "${outcomeLabel(outcome)}：$detail",
                )
            }
            "relay.error" -> {
                mutableState.value = mutableState.value.copy(
                    phase = ConnectionPhase.ERROR,
                    status = message.optJSONObject("payload")?.optString("reason") ?: "Relayエラー",
                )
            }
        }
    }

    private fun scheduleReconnect() {
        if (!shouldReconnect || relayUrl.isEmpty() || hostId.isEmpty()) return
        reconnectHandler.removeCallbacksAndMessages(null)
        reconnectHandler.postDelayed({
            if (shouldReconnect) connect(relayUrl, hostId)
        }, 3_000)
    }

    private fun applySnapshot(payload: JSONObject) {
        mutableState.value = mutableState.value.copy(
            phase = ConnectionPhase.ONLINE,
            status = payload.optString("connectionLabel", "PCオンライン"),
            workspace = payload.optString("workspace"),
            rootName = payload.optString("rootName"),
            rootStatus = payload.optString("rootStatus"),
            latestMessage = payload.optString("latestMessage"),
            pendingInstructions = payload.optInt("pendingInstructions"),
            approvalPending = payload.optBoolean("approvalPending"),
            questionPending = payload.optBoolean("questionPending"),
        )
    }

    private fun envelope(type: String, payload: JSONObject): String = JSONObject()
        .put("version", 1)
        .put("messageId", UUID.randomUUID().toString())
        .put("type", type)
        .put("hostId", hostId)
        .put("createdAt", Instant.now().toString())
        .put("payload", payload)
        .toString()

    private fun outcomeLabel(outcome: String): String = when (outcome) {
        "started" -> "実行開始"
        "queued" -> "待ち行列へ登録"
        "rejected" -> "受付拒否"
        "failed" -> "送信失敗"
        else -> outcome
    }
}
