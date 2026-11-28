package com.livestar.live

import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.Locale

/**
 * URL decisions are independent of WebView and do not perform DNS lookups.
 * The WebView must additionally require a main-frame user gesture before it
 * opens an external URL in another application.
 */
class NavigationPolicy(baseUrl: String) {
    private val origin: URI = parseHttp(baseUrl)
        ?: throw IllegalArgumentException("A public HTTPS origin is required.")

    private val trustedHost: String

    val baseOrigin: String

    init {
        val host = origin.host.lowercase(Locale.ROOT)
        require(origin.scheme.equals("https", ignoreCase = true))
        require(origin.port == -1 || origin.port == 443)
        require(origin.rawPath.isNullOrEmpty() || origin.rawPath == "/")
        require(origin.rawQuery == null && origin.rawFragment == null)
        require(isPublicDnsName(host)) { "A public DNS hostname is required." }
        trustedHost = host
        baseOrigin = "https://$host"
    }

    /** Only the configured HTTPS origin can remain inside the app. */
    fun isTrusted(url: String?): Boolean {
        val uri = parseHttp(url) ?: return false
        return uri.scheme.equals("https", ignoreCase = true) &&
            uri.host.equals(trustedHost, ignoreCase = true) &&
            (uri.port == -1 || uri.port == 443)
    }

    /**
     * A candidate for an explicit external-browser action, never an automatic
     * redirect. Other schemes and literal private/reserved addresses are refused.
     */
    fun externalHttpUrl(url: String?): String? {
        val uri = parseHttp(url) ?: return null
        if (!isPublicHost(uri.host.lowercase(Locale.ROOT))) return null
        return uri.toASCIIString()
    }

    /**
     * Resolves an app-owned absolute path to a trusted absolute URL.
     * Callers receive an absolute URL suitable for WebView.loadUrl.
     */
    fun safeInternalPath(path: String): String {
        require(path.startsWith("/") && !path.startsWith("//")) {
            "An internal absolute path is required."
        }
        require(!hasUnsafeCharacters(path)) { "The path contains unsafe characters." }
        val relative = try {
            URI(path)
        } catch (_: Exception) {
            throw IllegalArgumentException("The internal path is invalid.")
        }
        require(relative.scheme == null && relative.rawAuthority == null)
        require(relative.rawPath?.startsWith("/") == true)
        var decodedPath = relative.rawPath
        repeat(3) {
            require(!hasUnsafeCharacters(decodedPath) && !decodedPath.startsWith("//"))
            require(decodedPath.split('/').none { part -> part == "." || part == ".." }) {
                "Path traversal is not allowed."
            }
            decodedPath = try {
                // URLDecoder treats '+' as a space; in a path it is a literal.
                URLDecoder.decode(decodedPath.replace("+", "%2B"), StandardCharsets.UTF_8.name())
            } catch (_: Exception) {
                throw IllegalArgumentException("The internal path encoding is invalid.")
            }
        }
        require(!hasUnsafeCharacters(decodedPath) && !decodedPath.startsWith("//"))
        require(decodedPath.split('/').none { part -> part == "." || part == ".." })
        val absolute = baseOrigin + path
        require(isTrusted(absolute))
        return absolute
    }

    companion object {
        private val encodedUnsafe = Regex("%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)", RegexOption.IGNORE_CASE)
        private val dnsLabel = Regex("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")

        private fun hasUnsafeCharacters(value: String): Boolean =
            value.any {
                it == '\\' || it.isWhitespace() || it.code <= 0x1f || it.code == 0x7f ||
                    Character.getType(it) == Character.FORMAT.toInt()
            } || encodedUnsafe.containsMatchIn(value)

        private fun parseHttp(value: String?): URI? {
            if (value.isNullOrEmpty() || hasUnsafeCharacters(value)) return null
            val uri = try {
                URI(value)
            } catch (_: Exception) {
                return null
            }
            if (!uri.isAbsolute || uri.isOpaque || uri.rawUserInfo != null ||
                uri.host.isNullOrEmpty() || uri.rawAuthority.isNullOrEmpty() ||
                !(uri.scheme.equals("https", true) || uri.scheme.equals("http", true)) ||
                !(uri.port == -1 || uri.port in 1..65535)
            ) return null
            // Reject an empty explicit port rather than relying on a browser's
            // normalization of a different textual authority.
            if (uri.rawAuthority.endsWith(":")) return null
            return uri
        }

        private fun isPublicDnsName(host: String): Boolean {
            if (host.length > 253 || !host.contains('.') || host.endsWith('.') ||
                host.startsWith('[') || host.contains(':') ||
                host.all { it.isDigit() || it == '.' }
            ) return false
            val special = listOf("localhost", "local", "localdomain", "internal", "invalid", "test", "home.arpa")
            if (special.any { host == it || host.endsWith(".$it") }) return false
            val parts = host.split('.')
            return parts.all { dnsLabel.matches(it) } && parts.last().any { it in 'a'..'z' }
        }

        private fun isPublicHost(host: String): Boolean {
            if (host.startsWith('[') || host.contains(':')) return isPublicIpv6(host)
            if (host.all { it.isDigit() || it == '.' }) return isPublicIpv4(host)
            return isPublicDnsName(host)
        }

        private fun isPublicIpv4(host: String): Boolean {
            val parts = host.split('.')
            if (parts.size != 4 || parts.any { it.isEmpty() || (it.length > 1 && it.startsWith('0')) }) return false
            val bytes = parts.map { it.toIntOrNull() ?: return false }
            if (bytes.any { it !in 0..255 }) return false
            val a = bytes[0]
            val b = bytes[1]
            val c = bytes[2]
            return !(a == 0 || a == 10 || a == 127 || a >= 224 ||
                (a == 100 && b in 64..127) ||
                (a == 169 && b == 254) ||
                (a == 172 && b in 16..31) ||
                (a == 192 && (b == 168 || (b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99))) ||
                (a == 198 && (b in 18..19 || (b == 51 && c == 100))) ||
                (a == 203 && b == 0 && c == 113))
        }

        private fun isPublicIpv6(host: String): Boolean {
            val literal = host.removePrefix("[").removeSuffix("]")
            if (!literal.contains(':') || !Regex("[0-9a-fA-F:.]+").matches(literal)) return false
            val address = try {
                // A colon-delimited hexadecimal literal cannot trigger DNS.
                InetAddress.getByName(literal)
            } catch (_: Exception) {
                return false
            }
            if (address !is Inet6Address) return false
            val bytes = address.address
            val first = bytes[0].toInt() and 0xff
            if ((first and 0xe0) != 0x20) return false
            // Documentation prefix 2001:db8::/32 is not a public destination.
            return !((bytes[0].toInt() and 0xff) == 0x20 &&
                (bytes[1].toInt() and 0xff) == 0x01 &&
                (bytes[2].toInt() and 0xff) == 0x0d &&
                (bytes[3].toInt() and 0xff) == 0xb8)
        }
    }
}
