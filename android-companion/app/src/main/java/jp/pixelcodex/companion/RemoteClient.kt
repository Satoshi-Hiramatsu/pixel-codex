package jp.pixelcodex.companion

import android.os.Handler
import android.os.Looper
import java.io.IOException
import java.net.URI
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject

enum class ConnectionPhase { OFFLINE, CONNECTING, ONLINE, ERROR }

/** PCが出している承認待ち。可否をこの端末から返せるときだけ届きます。 */
data class ApprovalRequest(
    val requestId: String,
    val title: String,
    val headline: String,
    val bullets: List<String>,
    val command: String,
    val cwd: String,
    val riskLabel: String,
    val risk: String,
)

data class QuestionItem(
    val id: String,
    val header: String,
    val question: String,
    val options: List<String>,
)

data class QuestionRequest(
    val requestId: String,
    val questions: List<QuestionItem>,
)

/** PCが登録した撮影対象。端末はこのidを送り返すだけで、URLやパスは扱いません。 */
data class PreviewSource(
    val id: String,
    val kind: String,
    val label: String,
)

/**
 * 撮れた画像の在り処。画像そのものはWebSocketに載せられない（16KB上限・テキスト
 * のみ）ので、Relayの別経路から取りに行きます。
 */
data class PreviewImage(
    val previewId: String,
    val url: String,
    val width: Int,
    val height: Int,
    val bytes: Int,
)

data class PreviewState(
    val sources: List<PreviewSource> = emptyList(),
    val sourcesLoaded: Boolean = false,
    val busy: Boolean = false,
    val message: String = "",
    val image: PreviewImage? = null,
)

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
    val approval: ApprovalRequest? = null,
    val question: QuestionRequest? = null,
    val lastCommandResult: String = "",
    val preview: PreviewState = PreviewState(),
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
    // 再接続用とは分けます。あちらはdisconnectでまとめて取り消すので、画像の受け取りが
    // 巻き添えで消えてしまうためです。
    private val mainHandler = Handler(Looper.getMainLooper())

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
        val localDevelopment = url.startsWith("ws://10.0.2.2")
            || url.startsWith("ws://127.0.0.1")
            || url.startsWith("ws://localhost")
            || isPrivateLanUrl(url)
        if (!secure && !localDevelopment) {
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

    private fun isPrivateLanUrl(url: String): Boolean {
        if (!url.startsWith("ws://")) return false
        val host = runCatching { URI(url).host }.getOrNull() ?: return false
        if (host.startsWith("10.") || host.startsWith("192.168.")) return true
        val match = Regex("^172\\.(\\d+)\\.").find(host) ?: return false
        return match.groupValues[1].toIntOrNull() in 16..31
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

    fun requestPreviewSources(): Boolean {
        val socket = webSocket ?: return false
        if (mutableState.value.phase != ConnectionPhase.ONLINE) return false
        val payload = JSONObject().put("deviceId", deviceId)
        val sent = socket.send(envelope("preview.sources.request", payload))
        if (sent) updatePreview { it.copy(busy = true, message = "対象を確認中") }
        return sent
    }

    fun requestPreview(sourceId: String, viewport: String): Boolean {
        val socket = webSocket ?: return false
        if (mutableState.value.phase != ConnectionPhase.ONLINE) return false
        val payload = JSONObject()
            .put("deviceId", deviceId)
            .put("sourceId", sourceId)
            .put("viewport", viewport)
        val sent = socket.send(envelope("preview.request", payload))
        if (sent) updatePreview { it.copy(busy = true, message = "PCで撮影中", image = null) }
        return sent
    }

    /** 画像はWebSocketに載らないので、同じRelayのHTTP側から取ります。 */
    fun fetchPreview(url: String, onDone: (ByteArray?) -> Unit) {
        val request = Request.Builder().url(url).build()
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                mainHandler.post { onDone(null) }
            }

            override fun onResponse(call: Call, response: Response) {
                val data = response.use { if (it.isSuccessful) it.body.bytes() else null }
                mainHandler.post { onDone(data) }
            }
        })
    }

    private fun updatePreview(transform: (PreviewState) -> PreviewState) {
        mutableState.value = mutableState.value.copy(preview = transform(mutableState.value.preview))
    }

    /**
     * PCから届くのはRelayからの相対パスだけです。PCがどのアドレスで見えているかは
     * こちらしか知らず、接続に使っているトークンも手元にあるので、宛先はここで組み立てます。
     */
    private fun previewUrl(path: String): String {
        if (!path.startsWith("/")) return ""
        val relay = runCatching { URI(relayUrl) }.getOrNull() ?: return ""
        val host = relay.host ?: return ""
        val token = relay.query
            ?.split('&')
            ?.firstOrNull { it.startsWith("token=") }
            ?.removePrefix("token=")
            .orEmpty()
        if (token.isEmpty()) return ""
        val scheme = if (relay.scheme == "wss") "https" else "http"
        val port = if (relay.port > 0) ":${relay.port}" else ""
        return "$scheme://$host$port$path?token=$token"
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
                // プレビューの要求が受付前に弾かれると応答が返らないので、待ち表示を解きます。
                if (outcome == "rejected" || outcome == "failed") {
                    updatePreview {
                        if (it.busy) it.copy(busy = false, message = detail) else it
                    }
                }
            }
            "preview.sources" -> {
                val array = message.optJSONObject("payload")?.optJSONArray("sources")
                val sources = (0 until (array?.length() ?: 0)).mapNotNull { index ->
                    val item = array?.optJSONObject(index) ?: return@mapNotNull null
                    val id = item.optString("id")
                    val label = item.optString("label")
                    if (id.isEmpty() || label.isEmpty()) return@mapNotNull null
                    PreviewSource(id, item.optString("kind", "window"), label)
                }
                updatePreview {
                    it.copy(
                        sources = sources,
                        sourcesLoaded = true,
                        busy = false,
                        message = if (sources.isEmpty()) {
                            "PCの通信室で「画面プレビュー」を許可してください"
                        } else {
                            ""
                        },
                    )
                }
            }
            "preview.ready" -> {
                val payload = message.optJSONObject("payload") ?: return
                val url = previewUrl(payload.optString("path"))
                if (url.isEmpty()) {
                    updatePreview { it.copy(busy = false, message = "画像の取得先を組み立てられませんでした") }
                    return
                }
                updatePreview {
                    it.copy(
                        busy = false,
                        message = "",
                        image = PreviewImage(
                            previewId = payload.optString("previewId"),
                            url = url,
                            width = payload.optInt("width"),
                            height = payload.optInt("height"),
                            bytes = payload.optInt("bytes"),
                        ),
                    )
                }
            }
            "preview.failed" -> {
                val reason = message.optJSONObject("payload")?.optString("reason").orEmpty()
                updatePreview {
                    it.copy(busy = false, message = reason.ifEmpty { "撮影できませんでした" })
                }
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
            approval = payload.optJSONObject("approval")?.let(::readApproval),
            question = payload.optJSONObject("question")?.let(::readQuestion),
        )
    }

    private fun readApproval(payload: JSONObject): ApprovalRequest? {
        val requestId = payload.optString("requestId")
        if (requestId.isEmpty()) return null
        return ApprovalRequest(
            requestId = requestId,
            title = payload.optString("title", "承認が必要です"),
            headline = payload.optString("headline"),
            bullets = payload.optJSONArray("bullets").toStringList(),
            command = payload.optString("command"),
            cwd = payload.optString("cwd"),
            riskLabel = payload.optString("riskLabel"),
            risk = payload.optString("risk", "medium"),
        )
    }

    private fun readQuestion(payload: JSONObject): QuestionRequest? {
        val requestId = payload.optString("requestId")
        val rawQuestions = payload.optJSONArray("questions") ?: return null
        if (requestId.isEmpty()) return null
        val questions = (0 until rawQuestions.length()).mapNotNull { index ->
            val item = rawQuestions.optJSONObject(index) ?: return@mapNotNull null
            val id = item.optString("id")
            if (id.isEmpty()) return@mapNotNull null
            QuestionItem(
                id = id,
                header = item.optString("header"),
                question = item.optString("question"),
                options = item.optJSONArray("options").toStringList(),
            )
        }
        return if (questions.isEmpty()) null else QuestionRequest(requestId, questions)
    }

    fun sendApproval(requestId: String, accept: Boolean): Boolean {
        val socket = webSocket ?: return false
        if (mutableState.value.phase != ConnectionPhase.ONLINE) return false
        val payload = JSONObject()
            .put("deviceId", deviceId)
            .put("requestId", requestId)
            .put("decision", if (accept) "accept" else "decline")
        val sent = socket.send(envelope("approval.respond", payload))
        if (sent) {
            mutableState.value = mutableState.value.copy(
                lastCommandResult = if (accept) "承認をPCへ送信中" else "拒否をPCへ送信中",
            )
        }
        return sent
    }

    fun sendQuestionAnswers(requestId: String, answers: Map<String, String>): Boolean {
        val socket = webSocket ?: return false
        if (mutableState.value.phase != ConnectionPhase.ONLINE || answers.isEmpty()) return false
        val body = JSONObject()
        answers.forEach { (id, text) -> body.put(id, text.take(1_000)) }
        val payload = JSONObject()
            .put("deviceId", deviceId)
            .put("requestId", requestId)
            .put("answers", body)
        val sent = socket.send(envelope("question.respond", payload))
        if (sent) mutableState.value = mutableState.value.copy(lastCommandResult = "回答をPCへ送信中")
        return sent
    }

    private fun envelope(type: String, payload: JSONObject): String = JSONObject()
        .put("version", 1)
        .put("messageId", UUID.randomUUID().toString())
        .put("type", type)
        .put("hostId", hostId)
        .put("createdAt", Instant.now().toString())
        .put("payload", payload)
        .toString()

    private fun JSONArray?.toStringList(): List<String> {
        val array = this ?: return emptyList()
        return (0 until array.length()).mapNotNull { index ->
            array.optString(index).takeIf { it.isNotBlank() }
        }
    }

    private fun outcomeLabel(outcome: String): String = when (outcome) {
        "started" -> "実行開始"
        "queued" -> "待ち行列へ登録"
        "rejected" -> "受付拒否"
        "failed" -> "送信失敗"
        else -> outcome
    }
}
