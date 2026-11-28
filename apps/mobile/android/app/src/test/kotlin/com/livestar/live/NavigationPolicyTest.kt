package com.livestar.live

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NavigationPolicyTest {
    private val policy = NavigationPolicy("https://livestar-live-nitq.onrender.com")

    @Test
    fun sameOriginIncludesHttpsDefaultPortAndCaseInsensitiveHost() {
        assertTrue(policy.isTrusted("https://livestar-live-nitq.onrender.com/live/abc?tab=chat#latest"))
        assertTrue(policy.isTrusted("HTTPS://LIVESTAR-LIVE-NITQ.ONRENDER.COM:443/profile"))
        assertFalse(policy.isTrusted("http://livestar-live-nitq.onrender.com/"))
        assertFalse(policy.isTrusted("https://livestar-live-nitq.onrender.com:8443/"))
    }

    @Test
    fun hostnameLookalikesAndCredentialsCannotEnterWebView() {
        val rejected = listOf(
            "https://livestar-live-nitq.onrender.com.attacker.net/",
            "https://livestar-live-nitq-onrender.com/",
            "https://attacker.net@livestar-live-nitq.onrender.com/",
            "https://livestar-live-nitq.onrender.com@attacker.net/",
            "https://livestar-live-nitq.onrender.com./",
            "https://livestar-live-nitq.onrender.com:/",
            "//livestar-live-nitq.onrender.com/",
            "https:////livestar-live-nitq.onrender.com/",
        )
        rejected.forEach { assertFalse(it, policy.isTrusted(it)) }
    }

    @Test
    fun executableLocalAndOpaqueSchemesAreNeverBrowserCandidates() {
        listOf(
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///data/data/com.livestar.live/shared_prefs/account.xml",
            "content://private.provider/secret",
            "intent://livestar#Intent;scheme=https;end",
            "tel:+123456789",
            "mailto:person@public.net",
            "ftp://public.net/file",
        ).forEach {
            assertFalse(it, policy.isTrusted(it))
            assertNull(it, policy.externalHttpUrl(it))
        }
    }

    @Test
    fun externalBrowserCanReceiveOnlyExplicitPublicHttpUrls() {
        assertEquals("https://github.com/dulyd67-arch/new_liev", policy.externalHttpUrl("https://github.com/dulyd67-arch/new_liev"))
        assertEquals("http://www.wikipedia.org/", policy.externalHttpUrl("http://www.wikipedia.org/"))
        assertEquals("https://8.8.8.8/", policy.externalHttpUrl("https://8.8.8.8/"))
        assertEquals("https://[2606:4700:4700::1111]/", policy.externalHttpUrl("https://[2606:4700:4700::1111]/"))
        assertNull(policy.externalHttpUrl("https://name:password@github.com/"))
    }

    @Test
    fun privateLoopbackReservedAndAmbiguousLiteralHostsAreRefused() {
        listOf(
            "localhost", "router.local", "service.internal", "name.invalid", "host.test", "printer",
            "127.0.0.1", "127.1", "2130706433", "0177.0.0.1", "10.0.0.5", "172.16.0.1",
            "172.31.255.255", "192.168.0.1", "169.254.169.254", "100.64.0.1", "198.18.0.1",
            "192.0.2.1", "198.51.100.2", "203.0.113.3", "224.0.0.1", "255.255.255.255",
            "[::1]", "[fc00::1]", "[fe80::1]", "[2001:db8::1]", "[::ffff:127.0.0.1]",
        ).forEach { assertNull(it, policy.externalHttpUrl("https://$it/")) }
    }

    @Test
    fun rawAndEncodedControlCharactersAndBackslashesAreRefused() {
        listOf(
            "https://github.com/\nnext",
            "https://github.com/\r\nHeader:value",
            "https://github.com/a b",
            "https://github.com/\u0000",
            "https://github.com/\u202Ehidden",
            "https://github.com\\@attacker.net/",
            "https://github.com/%0d%0aHeader",
            "https://github.com/%5cattacker",
            "https://github.com/%00",
            "https://github.com/%7F",
        ).forEach { assertNull(it, policy.externalHttpUrl(it)) }
    }

    @Test
    fun appRouteResolutionPreservesLegitimateQueryAndFragment() {
        assertEquals(
            "https://livestar-live-nitq.onrender.com/login?returnTo=%2Fadmin#sign-in",
            policy.safeInternalPath("/login?returnTo=%2Fadmin#sign-in"),
        )
        assertEquals("https://livestar-live-nitq.onrender.com/ai-host", policy.safeInternalPath("/ai-host"))
        assertEquals("https://livestar-live-nitq.onrender.com/a+b", policy.safeInternalPath("/a+b"))
    }

    @Test
    fun appRoutesCannotEscapeOrSmugglePathTraversal() {
        listOf(
            "//attacker.net/",
            "https://attacker.net/",
            "javascript:alert(1)",
            "/\\attacker.net",
            "/../admin",
            "/a/./admin",
            "/a/%2e%2e/admin",
            "/a/%252e%252e/admin",
            "/%2f%2fattacker.net/",
            "/%255cattacker.net/",
            "/safe%00path",
        ).forEach { route ->
            var rejected = false
            try {
                policy.safeInternalPath(route)
            } catch (_: IllegalArgumentException) {
                rejected = true
            }
            assertTrue(route, rejected)
        }
    }

    @Test
    fun deploymentOriginCannotBeAnUntrustedOrPathScopedAddress() {
        listOf(
            "http://livestar-live-nitq.onrender.com/",
            "https://localhost/",
            "https://127.0.0.1/",
            "https://router.local/",
            "https://user:secret@livestar-live-nitq.onrender.com/",
            "https://livestar-live-nitq.onrender.com:8443/",
            "https://livestar-live-nitq.onrender.com/profile",
            "https://livestar-live-nitq.onrender.com/?returnTo=other",
            "https://livestar-live-nitq.onrender.com/#other",
        ).forEach { origin ->
            var rejected = false
            try {
                NavigationPolicy(origin)
            } catch (_: IllegalArgumentException) {
                rejected = true
            }
            assertTrue(origin, rejected)
        }
    }
}
