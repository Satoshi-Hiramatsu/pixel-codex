package jp.pixelcodex.companion

import android.os.Handler
import android.os.Looper
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

/**
 * PCのアドレスが変わっても付き合えるようにするための探索。トークンとHost IDは
 * 保存済みなので、いまPCがLANのどこにいるかだけ分かれば接続し直せます。
 *
 * 探すのは次の2つの/24です。端末とPCが別セグメントに置かれる構成があるため、
 * 端末自身のサブネットだけでは足りません。
 *   1. 前回PCがいたサブネット（IPが振り直されただけならここで見つかります）
 *   2. 端末自身のサブネット（PCが同じ側へ移ってきた場合）
 *
 * `/health`はHost IDを名乗るだけで、探索中にトークンは一切送りません。
 */
class RelayFinder {
    data class Found(val host: String, val port: Int)

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(400, TimeUnit.MILLISECONDS)
        .readTimeout(700, TimeUnit.MILLISECONDS)
        .build()
    private val mainHandler = Handler(Looper.getMainLooper())

    private data class Segment(val prefix: String, val anchor: Int)

    fun find(hostId: String, knownHost: String, preferredPort: Int, onDone: (Found?, String) -> Unit) {
        Thread {
            val ports = portsToTry(preferredPort)
            val segments = segmentsToSweep(knownHost)
            val found = when {
                segments.isEmpty() -> null
                // まず前回のアドレスをそのまま。単に一時的に落ちていただけならこれで済みます。
                knownHost.isNotBlank() && identify(knownHost, preferredPort) == hostId ->
                    Found(knownHost, preferredPort)
                else -> sweep(segments, hostId, ports)
            }
            val note = when {
                segments.isEmpty() -> "ネットワークに接続していないため探索できません"
                found == null -> "PCが見つかりませんでした（${segments.joinToString("、") { "${it.prefix}.0/24" }}を探索）"
                else -> "PCを${found.host}:${found.port}で見つけました"
            }
            mainHandler.post { onDone(found, note) }
        }.start()
    }

    private fun segmentsToSweep(knownHost: String): List<Segment> {
        val segments = LinkedHashSet<Segment>()
        segmentOf(knownHost)?.let(segments::add)
        segmentOf(localIpv4())?.let(segments::add)
        return segments.toList()
    }

    private fun segmentOf(address: String?): Segment? {
        val text = address?.trim().orEmpty()
        if (text.isEmpty()) return null
        val lastDot = text.lastIndexOf('.')
        if (lastDot <= 0) return null
        val anchor = text.substring(lastDot + 1).toIntOrNull() ?: return null
        val prefix = text.substring(0, lastDot)
        if (prefix.count { it == '.' } != 2) return null
        return Segment(prefix, anchor)
    }

    /** 端末自身のプライベートIPv4。権限は要りません。 */
    private fun localIpv4(): String? {
        val interfaces = runCatching { NetworkInterface.getNetworkInterfaces().toList() }.getOrNull()
            ?: return null
        for (networkInterface in interfaces) {
            if (!networkInterface.isUp || networkInterface.isLoopback) continue
            for (address in networkInterface.inetAddresses) {
                if (address !is Inet4Address || address.isLoopbackAddress) continue
                if (!address.isSiteLocalAddress) continue
                return address.hostAddress
            }
        }
        return null
    }

    private fun portsToTry(preferredPort: Int): List<Int> {
        val ports = LinkedHashSet<Int>()
        if (preferredPort in 1..65_535) ports.add(preferredPort)
        for (port in defaultPort until defaultPort + defaultPortSpan) ports.add(port)
        return ports.toList()
    }

    /** 前回いた番地に近いところから見ていきます。DHCPは近い番号を配りがちなためです。 */
    private fun candidateOrder(segment: Segment): List<Int> =
        (1..254).sortedBy { kotlin.math.abs(it - segment.anchor) }

    private fun sweep(segments: List<Segment>, hostId: String, ports: List<Int>): Found? {
        for (port in ports) {
            for (segment in segments) {
                val result = AtomicReference<Found?>(null)
                val pool = Executors.newFixedThreadPool(threadCount)
                for (octet in candidateOrder(segment)) {
                    pool.execute {
                        if (result.get() != null) return@execute
                        val host = "${segment.prefix}.$octet"
                        if (identify(host, port) == hostId) result.compareAndSet(null, Found(host, port))
                    }
                }
                pool.shutdown()
                pool.awaitTermination(sweepTimeoutSeconds, TimeUnit.SECONDS)
                result.get()?.let { return it }
            }
        }
        return null
    }

    /** `/health`が名乗るHost ID。Pixel Codex以外はここで弾かれます。 */
    private fun identify(host: String, port: Int): String? {
        val request = Request.Builder().url("http://$host:$port/health").get().build()
        return runCatching {
            httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return null
                JSONObject(response.body.string()).optString("hostId").takeIf { it.isNotBlank() }
            }
        }.getOrNull()
    }

    companion object {
        private const val defaultPort = 57170
        private const val defaultPortSpan = 3
        private const val threadCount = 48
        private const val sweepTimeoutSeconds = 25L
    }
}

/** 見つけ直したアドレスへ差し替えます。トークンを含むクエリはそのまま残します。 */
fun relayUrlWithHost(relayUrl: String, host: String, port: Int): String? {
    val uri = runCatching { URI(relayUrl.trim()) }.getOrNull() ?: return null
    val scheme = uri.scheme ?: return null
    val query = uri.rawQuery?.let { "?$it" } ?: ""
    val path = uri.rawPath.ifEmpty { "/relay" }
    return "$scheme://$host:$port$path$query"
}

fun relayPortOf(relayUrl: String): Int =
    runCatching { URI(relayUrl.trim()).port }.getOrNull()?.takeIf { it > 0 } ?: 57170

fun relayHostOf(relayUrl: String): String =
    runCatching { URI(relayUrl.trim()).host }.getOrNull().orEmpty()
