package jp.pixelcodex.companion

import org.json.JSONObject

/**
 * PCが表示するQRの中身。PC側の `RemoteProtocol.ts` と対になっています。
 * - Lan … 同一Wi-Fi。ペアリングコードと引き換えにトークンを受け取ります。
 * - Url … 外部Relay。URLに認証情報が入っているのでそのまま接続します。
 */
sealed interface ScannedConnection {
    data class Lan(val host: String, val port: Int, val code: String) : ScannedConnection
    data class Url(val relayUrl: String, val hostId: String) : ScannedConnection
}

private val loopbackHosts = setOf("127.0.0.1", "localhost", "::1", "[::1]")

/**
 * 端末から見ると自分自身を指すアドレス。USB接続時のadb reverse以外では届きません。
 */
fun isLoopbackUrl(url: String): Boolean {
    val host = runCatching { java.net.URI(url.trim()).host }.getOrNull() ?: return false
    return host in loopbackHosts
}

/** 保存済みの接続先を画面に出すための表示用。認証情報は落とします。 */
fun describeRelayUrl(url: String): String {
    if (url.isBlank()) return "未設定"
    val uri = runCatching { java.net.URI(url.trim()) }.getOrNull() ?: return "不正なURL"
    val port = if (uri.port > 0) ":${uri.port}" else ""
    return "${uri.scheme}://${uri.host}$port"
}

fun parsePairingQr(text: String): ScannedConnection? {
    val json = runCatching { JSONObject(text.trim()) }.getOrNull() ?: return null
    if (json.optInt("v") != 1) return null
    return when (json.optString("t")) {
        "lan" -> {
            val host = json.optString("h")
            val port = json.optInt("p")
            val code = json.optString("c")
            if (host.isBlank() || port !in 1..65_535 || code.length != PairingClient.codeLength) null
            else ScannedConnection.Lan(host, port, code)
        }
        "url" -> {
            val relayUrl = json.optString("u")
            val hostId = json.optString("i")
            if (relayUrl.isBlank() || hostId.isBlank()) null
            else ScannedConnection.Url(relayUrl, hostId)
        }
        else -> null
    }
}
