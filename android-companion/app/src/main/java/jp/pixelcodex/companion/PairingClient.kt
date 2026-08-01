package jp.pixelcodex.companion

import android.os.Build
import android.os.Handler
import android.os.Looper
import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** ペアリングの結果。成功すればRelay URLとHost IDがそのまま接続設定になります。 */
sealed interface PairingOutcome {
    data class Success(val relayUrl: String, val hostId: String) : PairingOutcome
    data class Failure(val message: String) : PairingOutcome
}

/**
 * PCの6桁コードと引き換えにRelayトークンを受け取ります。ケーブルは使いません。
 * ポートを省略された場合はPC側の既定範囲を順に叩いて待ち受けを探します。
 */
class PairingClient {
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(1_200, TimeUnit.MILLISECONDS)
        .readTimeout(4, TimeUnit.SECONDS)
        .build()
    private val mainHandler = Handler(Looper.getMainLooper())

    fun pair(address: String, code: String, onDone: (PairingOutcome) -> Unit) {
        val host = address.trim().substringBefore(':').trim()
        val explicitPort = address.trim().substringAfter(':', "").toIntOrNull()
        val digits = code.filter { it.isDigit() }
        if (host.isEmpty()) {
            onDone(PairingOutcome.Failure("PCのアドレスを入力してください"))
            return
        }
        if (digits.length != codeLength) {
            onDone(PairingOutcome.Failure("ペアリングコードは${codeLength}桁です"))
            return
        }
        val ports = explicitPort?.let { listOf(it) } ?: (defaultPort until defaultPort + portScanRange).toList()
        Thread {
            val outcome = attempt(host, ports, digits)
            mainHandler.post { onDone(outcome) }
        }.start()
    }

    private fun attempt(host: String, ports: List<Int>, code: String): PairingOutcome {
        var lastNetworkError: String? = null
        for (port in ports) {
            val body = JSONObject()
                .put("code", code)
                .put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
                .toString()
                .toRequestBody("application/json".toMediaType())
            val request = Request.Builder()
                .url("http://$host:$port/pair")
                .post(body)
                .build()
            try {
                httpClient.newCall(request).execute().use { response ->
                    val text = response.body.string()
                    val json = runCatching { JSONObject(text) }.getOrNull()
                    if (!response.isSuccessful) {
                        // 応答があった時点でPCは見つかっています。次のポートは試しません。
                        return PairingOutcome.Failure(
                            json?.optString("error").takeUnless { it.isNullOrBlank() }
                                ?: "ペアリングを拒否されました (${response.code})",
                        )
                    }
                    val relayUrl = json?.optString("relayUrl").orEmpty()
                    val hostId = json?.optString("hostId").orEmpty()
                    if (relayUrl.isEmpty() || hostId.isEmpty()) {
                        return PairingOutcome.Failure("PCの応答を解釈できませんでした")
                    }
                    return PairingOutcome.Success(relayUrl, hostId)
                }
            } catch (error: IOException) {
                lastNetworkError = error.message
            }
        }
        return PairingOutcome.Failure(
            "PCが見つかりません。同じWi-Fiにいるか、PCでペアリングを開始したか確認してください" +
                (lastNetworkError?.let { "（$it）" } ?: ""),
        )
    }

    companion object {
        const val codeLength = 6
        private const val defaultPort = 57170
        private const val portScanRange = 10
    }
}
