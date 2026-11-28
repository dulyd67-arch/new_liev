import 'package:flutter/services.dart';

/// A Flutter-to-native channel. No JavaScript interface is installed in the page.
class BrowserBridge {
  BrowserBridge(int viewId, void Function(Map<Object?, Object?>) onState)
      : _channel = MethodChannel('livestar/browser/$viewId') {
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'state' && call.arguments is Map) {
        onState(Map<Object?, Object?>.from(call.arguments as Map));
      }
    });
  }

  final MethodChannel _channel;

  Future<Map<Object?, Object?>> state() async {
    final result = await _channel.invokeMapMethod<Object?, Object?>('state');
    return result ?? <Object?, Object?>{};
  }

  Future<void> navigate(String path) =>
      _channel.invokeMethod<void>('navigate', {'path': path});
  Future<void> back() => _channel.invokeMethod<void>('back');
  Future<void> openBrowser() => _channel.invokeMethod<void>('openBrowser');
  Future<void> locale(String language) =>
      _channel.invokeMethod<void>('locale', {'language': language});
  void dispose() => _channel.setMethodCallHandler(null);
}
