package com.livestar.live

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.platform.PlatformView

/**
 * The web page receives no native JavaScript bridge. Media prompts are scoped
 * to both PermissionRequest.origin and the current top-level HTTPS origin.
 */
@Suppress("DEPRECATION")
class LiveStarBrowserView(
    private val activity: MainActivity,
    messenger: BinaryMessenger,
    viewId: Int,
    parameters: Map<*, *>,
    private val onReleased: (LiveStarBrowserView) -> Unit
) : PlatformView {
    private val policy = NavigationPolicy(
        parameters["baseUrl"] as? String ?: "https://livestar-live-nitq.onrender.com"
    )
    private val channel = MethodChannel(messenger, "livestar/browser/$viewId")
    private val container = FrameLayout(activity)
    private val webView = WebView(activity)
    private var disposed = false
    private var rendererGone = false
    private var loading = true
    private var progress = 0
    private var error: String? = null
    private var currentUrl = policy.safeInternalPath(parameters["initialPath"] as? String ?: "/")
    private var language = (parameters["locale"] as? String).let { if (it == "en") "en" else "ar" }
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var pendingMedia: PermissionRequest? = null
    private var pendingMediaResources: Array<String> = emptyArray()
    private var mediaNavigation = 0
    private var navigation = 0
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var fileNavigation = 0
    private var localeApplied = false
    private var pausedHosting = false

    companion object {
        private const val MEDIA_PERMISSION = 4017
        private const val PHOTO_PICKER = 4018
    }

    init {
        container.setBackgroundColor(Color.rgb(9, 7, 14))
        webView.setBackgroundColor(Color.rgb(9, 7, 14))
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = true // Only user-selected photo picker URIs.
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            safeBrowsingEnabled = true
            builtInZoomControls = false
            displayZoomControls = false
            loadWithOverviewMode = true
            useWideViewPort = true
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)
        webView.webViewClient = client()
        webView.webChromeClient = chrome()
        container.addView(webView, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
        ))
        channel.setMethodCallHandler { call, result ->
            if (disposed) {
                result.error("DISPOSED", "The browser has closed.", null)
                return@setMethodCallHandler
            }
            try {
                when (call.method) {
                    "state" -> result.success(state())
                    "navigate" -> {
                        val path = call.argument<String>("path") ?: "/"
                        webView.loadUrl(policy.safeInternalPath(path))
                        result.success(null)
                    }
                    "back" -> {
                        if (customView != null) hideFullscreen()
                        else if (webView.canGoBack()) webView.goBack()
                        result.success(null)
                    }
                    "openBrowser" -> {
                        if (!policy.isTrusted(currentUrl) || !openExternal(currentUrl)) {
                            result.error("BROWSER_UNAVAILABLE", "No browser could open this link.", null)
                        } else result.success(null)
                    }
                    "locale" -> {
                        val requested = call.argument<String>("language")
                        if (requested != "ar" && requested != "en") {
                            result.error("INVALID_LOCALE", "Unsupported language.", null)
                        } else {
                            language = requested
                            localeApplied = false
                            applyLocale()
                            result.success(null)
                        }
                    }
                    else -> result.notImplemented()
                }
            } catch (_: IllegalArgumentException) {
                result.error("UNTRUSTED_NAVIGATION", "This address is not allowed.", null)
            }
        }
        webView.loadUrl(currentUrl)
    }

    override fun getView(): View = container

    private fun state(): Map<String, Any?> = mapOf(
        "url" to currentUrl,
        "loading" to loading,
        "progress" to progress,
        "canGoBack" to (!rendererGone && webView.canGoBack()),
        "fullscreen" to (customView != null),
        "error" to error
    )

    private fun emit() {
        if (!disposed) channel.invokeMethod("state", state())
    }

    private fun fail(code: String) {
        error = code
        loading = false
        denyMedia()
        emit()
    }

    private fun client() = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val target = request.url.toString()
            if (policy.isTrusted(target)) return false
            // Redirects, subframes and script-driven links cannot open external apps.
            if (request.isForMainFrame && request.hasGesture()) {
                policy.externalHttpUrl(target)?.let { openExternal(it) }
            }
            return true
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            if (!policy.isTrusted(url)) {
                view.stopLoading()
                fail("untrusted")
                return
            }
            navigation++
            denyMedia()
            cancelPhoto()
            currentUrl = url
            loading = true
            progress = 0
            error = null
            updateWake()
            emit()
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (!policy.isTrusted(url)) return
            currentUrl = url
            loading = false
            progress = 100
            applyLocale()
            CookieManager.getInstance().flush()
            updateWake()
            emit()
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            if (!policy.isTrusted(url)) return
            currentUrl = url
            updateWake()
            emit()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, received: WebResourceError) {
            if (request.isForMainFrame) fail("network")
        }

        override fun onReceivedHttpError(
            view: WebView,
            request: WebResourceRequest,
            response: android.webkit.WebResourceResponse
        ) {
            if (request.isForMainFrame && response.statusCode >= 400) fail("network")
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, received: SslError) {
            handler.cancel()
            fail("tls")
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            rendererGone = true
            error = "renderer"
            loading = false
            denyMedia()
            cancelPhoto()
            emit()
            return true // Flutter recreates the complete PlatformView on Retry.
        }
    }

    private fun chrome() = object : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            progress = newProgress.coerceIn(0, 100)
            emit()
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            val known = setOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE, PermissionRequest.RESOURCE_AUDIO_CAPTURE)
            if (disposed || pendingMedia != null || !policy.isTrusted(request.origin.toString())
                || !policy.isTrusted(currentUrl) || request.resources.isEmpty()
                || request.resources.any { it !in known }) {
                request.deny()
                return
            }
            pendingMedia = request
            pendingMediaResources = request.resources.copyOf()
            mediaNavigation = navigation
            val needed = mutableListOf<String>()
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE in pendingMediaResources
                && activity.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                needed += Manifest.permission.CAMERA
            }
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE in pendingMediaResources
                && activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                needed += Manifest.permission.RECORD_AUDIO
            }
            if (needed.isEmpty()) finishMedia()
            else activity.requestPermissions(needed.toTypedArray(), MEDIA_PERMISSION)
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest) {
            if (pendingMedia === request) {
                pendingMedia = null
                pendingMediaResources = emptyArray()
            }
        }

        override fun onGeolocationPermissionsShowPrompt(
            origin: String,
            callback: GeolocationPermissions.Callback
        ) {
            callback.invoke(origin, false, false)
        }

        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: WebChromeClient.FileChooserParams
        ): Boolean {
            cancelPhoto()
            if (!policy.isTrusted(currentUrl)) {
                callback.onReceiveValue(null)
                return true
            }
            val accepted = params.acceptTypes.filter { it.isNotBlank() }
            if (accepted.isNotEmpty() && accepted.any {
                    it != "image/*" && it != "image/jpeg" && it != "image/png" && it != "image/webp"
                }) {
                callback.onReceiveValue(null)
                return true
            }
            fileCallback = callback
            fileNavigation = navigation
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "image/*"
                putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("image/jpeg", "image/png", "image/webp"))
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            return try {
                activity.startActivityForResult(intent, PHOTO_PICKER)
                true
            } catch (_: ActivityNotFoundException) {
                cancelPhoto()
                true
            }
        }

        override fun onShowCustomView(view: View, callback: WebChromeClient.CustomViewCallback) {
            if (customView != null || disposed) {
                callback.onCustomViewHidden()
                return
            }
            customView = view
            customViewCallback = callback
            webView.visibility = View.GONE
            container.addView(view, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            ))
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
            emit()
        }

        override fun onHideCustomView() = hideFullscreen()
    }

    private fun denyMedia() {
        pendingMedia?.deny()
        pendingMedia = null
        pendingMediaResources = emptyArray()
    }

    private fun finishMedia() {
        val request = pendingMedia ?: return
        val resources = pendingMediaResources
        pendingMedia = null
        pendingMediaResources = emptyArray()
        val authorized = !disposed && mediaNavigation == navigation
            && policy.isTrusted(request.origin.toString()) && policy.isTrusted(currentUrl)
            && resources.all {
                val permission = if (it == PermissionRequest.RESOURCE_VIDEO_CAPTURE) {
                    Manifest.permission.CAMERA
                } else Manifest.permission.RECORD_AUDIO
                activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
            }
        if (authorized) request.grant(resources) else request.deny()
    }

    fun permissionResult(requestCode: Int, permissions: Array<out String>, grants: IntArray): Boolean {
        if (requestCode != MEDIA_PERMISSION) return false
        // Re-read actual OS permission state instead of trusting a stale result array.
        finishMedia()
        return true
    }

    private fun cancelPhoto() {
        fileCallback?.onReceiveValue(null)
        fileCallback = null
    }

    fun activityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != PHOTO_PICKER) return false
        val callback = fileCallback ?: return true
        fileCallback = null
        val uri = data?.data
        val allowed = !disposed && fileNavigation == navigation && policy.isTrusted(currentUrl)
            && resultCode == Activity.RESULT_OK && uri?.scheme == "content"
        callback.onReceiveValue(if (allowed) arrayOf(uri!!) else null)
        return true
    }

    private fun applyLocale() {
        if (disposed || rendererGone || localeApplied || !policy.isTrusted(currentUrl)) return
        localeApplied = true
        // A fixed, validated preference operation; no web-callable interface or tokens.
        val selected = if (language == "en") "en" else "ar"
        webView.evaluateJavascript(
            "(function(){try{var k='livestar-locale';if(localStorage.getItem(k)!='$selected'){" +
                "localStorage.setItem(k,'$selected');location.reload();}}catch(e){}})();",
            null
        )
    }

    private fun openExternal(value: String): Boolean {
        val safe = policy.externalHttpUrl(value) ?: return false
        return try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(safe)).apply {
                addCategory(Intent.CATEGORY_BROWSABLE)
            })
            true
        } catch (_: ActivityNotFoundException) {
            false
        } catch (_: SecurityException) {
            false
        }
    }

    private fun hideFullscreen() {
        customView?.let { container.removeView(it) }
        customView = null
        val callback = customViewCallback
        customViewCallback = null
        callback?.onCustomViewHidden()
        if (!rendererGone) webView.visibility = View.VISIBLE
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
        emit()
    }

    private fun updateWake() {
        val path = Uri.parse(currentUrl).path
        val hosting = path == "/go-live" || path == "/ai-host"
        webView.keepScreenOn = hosting
        if (hosting) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    fun pause() {
        if (disposed || rendererGone) return
        val path = Uri.parse(currentUrl).path
        pausedHosting = path == "/go-live" || path == "/ai-host"
        // Both current studios already close their actual media on pagehide.
        webView.evaluateJavascript("window.dispatchEvent(new Event('pagehide'));", null)
        webView.onPause()
        CookieManager.getInstance().flush()
        denyMedia()
        hideFullscreen()
    }

    fun resume() {
        if (disposed || rendererGone) return
        webView.onResume()
        if (pausedHosting) {
            pausedHosting = false
            webView.reload()
        }
        updateWake()
    }

    override fun dispose() {
        if (disposed) return
        disposed = true
        denyMedia()
        cancelPhoto()
        channel.setMethodCallHandler(null)
        hideFullscreen()
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (!rendererGone) {
            webView.evaluateJavascript("window.dispatchEvent(new Event('pagehide'));", null)
            webView.stopLoading()
        }
        container.removeAllViews()
        webView.destroy()
        onReleased(this)
    }
}
