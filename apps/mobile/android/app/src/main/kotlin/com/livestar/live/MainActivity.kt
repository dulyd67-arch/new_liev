package com.livestar.live

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.StandardMessageCodec
import io.flutter.plugin.platform.PlatformView
import io.flutter.plugin.platform.PlatformViewFactory

class MainActivity : FlutterActivity() {
    private var browser: LiveStarBrowserView? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        flutterEngine.platformViewsController.registry.registerViewFactory(
            "livestar/browser",
            object : PlatformViewFactory(StandardMessageCodec.INSTANCE) {
                override fun create(
                    context: android.content.Context,
                    viewId: Int,
                    args: Any?
                ): PlatformView {
                    val parameters = args as? Map<*, *> ?: emptyMap<Any, Any>()
                    return LiveStarBrowserView(
                        this@MainActivity,
                        flutterEngine.dartExecutor.binaryMessenger,
                        viewId,
                        parameters
                    ) { released ->
                        if (browser === released) browser = null
                    }.also { browser = it }
                }
            }
        )
    }

    override fun onPause() {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        super.onPause()
    }

    override fun onStop() {
        // A translucent Android permission dialog may pause this activity.
        // Only a fully hidden activity ends the foreground hosting session.
        browser?.pause()
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        browser?.resume()
    }

    @Deprecated("Android activity compatibility callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (browser?.activityResult(requestCode, resultCode, data) != true) {
            super.onActivityResult(requestCode, resultCode, data)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        if (browser?.permissionResult(requestCode, permissions, grantResults) != true) {
            super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        }
    }
}
