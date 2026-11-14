import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import 'token_store.dart';

class ApiException implements Exception {
  const ApiException(this.status, this.message);
  final int status;
  final String message;
  @override
  String toString() => message;
}

String defaultApiUrl() {
  const supplied = String.fromEnvironment('LIVESTAR_API_URL');
  if (supplied.isNotEmpty) return supplied;
  if (kReleaseMode) {
    throw StateError('Set LIVESTAR_API_URL to your HTTPS API origin for release builds.');
  }
  return defaultTargetPlatform == TargetPlatform.android
      ? 'http://10.0.2.2:4001/api/v1'
      : 'http://127.0.0.1:4001/api/v1';
}

/// Client-scoped rotation avoids replaying a predecessor from concurrent calls.
/// Refresh tokens are never sent to the web cookie endpoints.
class ApiClient extends ChangeNotifier {
  ApiClient({required TokenStore tokenStore, Dio? dio, String? baseUrl})
      : _store = tokenStore,
        _dio = dio ?? Dio() {
    final target = Uri.parse(baseUrl ?? defaultApiUrl());
    if (!target.hasAuthority ||
        !['http', 'https'].contains(target.scheme) ||
        target.userInfo.isNotEmpty ||
        (kReleaseMode && target.scheme != 'https')) {
      throw ArgumentError('A valid HTTPS API URL is required for release builds.');
    }
    _dio.options = BaseOptions(
      baseUrl: target.toString().replaceFirst(RegExp(r'/$'), ''),
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 15),
      sendTimeout: const Duration(seconds: 15),
      contentType: Headers.jsonContentType,
      responseType: ResponseType.json,
      followRedirects: false,
      validateStatus: (status) => status != null,
    );
  }

  final TokenStore _store;
  final Dio _dio;
  String? _accessToken;
  Map<String, dynamic>? _brief;
  Future<void>? _rotation;

  bool get isAuthenticated => _accessToken != null;
  Map<String, dynamic>? get brief => _brief;

  Future<void> restore() async {
    if (await _store.read() == null) return;
    try {
      await _rotate();
    } on ApiException catch (error) {
      // A temporary network failure must not erase an otherwise valid secret.
      if (error.status == 401 || error.status == 403) await clearSession();
    }
  }

  Future<Map<String, dynamic>> login(String email, String password) async {
    final result = _object(await request('POST', '/auth/mobile/login',
        data: {'email': email.trim(), 'password': password}, authenticated: false));
    await _accept(result);
    return result;
  }

  Future<Map<String, dynamic>> register(Map<String, dynamic> input) async {
    final result = _object(await request('POST', '/auth/mobile/register',
        data: input, authenticated: false));
    await _accept(result);
    return result;
  }

  Future<void> logout() async {
    try {
      if (isAuthenticated) await request('POST', '/auth/mobile/logout');
    } finally {
      await clearSession();
    }
  }

  Future<void> clearSession() async {
    _accessToken = null;
    _brief = null;
    await _store.delete();
    notifyListeners();
  }

  Future<void> _accept(Map<String, dynamic> result) async {
    final access = result['accessToken'];
    final refresh = result['refreshToken'];
    final user = result['user'];
    if (access is! String ||
        access.isEmpty ||
        refresh is! String ||
        !RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(refresh) ||
        user is! Map) {
      throw const ApiException(502, 'The authentication service returned an invalid response.');
    }
    await _store.write(refresh);
    _accessToken = access;
    _brief = Map<String, dynamic>.from(user);
    notifyListeners();
  }

  Future<void> _rotate() => _rotation ??= _performRotation().whenComplete(() {
        _rotation = null;
      });

  Future<void> _performRotation() async {
    final refresh = await _store.read();
    if (refresh == null) throw const ApiException(401, 'Sign in to continue.');
    try {
      final result = await _send('POST', '/auth/mobile/refresh',
          data: {'refreshToken': refresh}, authenticated: false);
      await _accept(_object(result));
    } on ApiException catch (error) {
      if (error.status == 401 || error.status == 403) await clearSession();
      rethrow;
    }
  }

  Future<dynamic> request(String method, String path,
      {dynamic data, bool authenticated = true}) async {
    try {
      return await _send(method, path, data: data, authenticated: authenticated);
    } on ApiException catch (error) {
      if (authenticated && error.status == 401) {
        await _rotate();
        return _send(method, path, data: data, authenticated: true);
      }
      rethrow;
    }
  }

  Future<dynamic> _send(String method, String path,
      {dynamic data, required bool authenticated}) async {
    try {
      final response = await _dio.request<dynamic>(path,
          data: data,
          options: Options(method: method, headers: {
            if (authenticated && _accessToken != null)
              'Authorization': 'Bearer $_accessToken',
          }));
      final status = response.statusCode ?? 0;
      if (status < 200 || status > 299) {
        final body = response.data;
        final supplied = body is Map ? body['message'] : null;
        final message = status >= 500
            ? 'The service is temporarily unavailable.'
            : supplied is String
                ? supplied
                : supplied is List
                    ? supplied.whereType<String>().join('\n')
                    : 'The request could not be completed.';
        throw ApiException(status, message);
      }
      return response.data;
    } on DioException {
      throw const ApiException(0, 'Unable to reach LiveStar. Check your connection and try again.');
    }
  }

  static Map<String, dynamic> _object(dynamic value) {
    if (value is! Map) throw const ApiException(502, 'Invalid service response.');
    return Map<String, dynamic>.from(value);
  }

  Future<Map<String, dynamic>> ownProfile() async =>
      _object(await request('GET', '/users/me'));

  Future<Map<String, dynamic>> platform() async =>
      _object(await request('GET', '/platform', authenticated: false));

  Future<List<Map<String, dynamic>>> search(String query) async {
    final result = _object(await request('GET',
        '/users?query=${Uri.encodeQueryComponent(query.trim())}&limit=20',
        authenticated: false));
    return (result['items'] as List? ?? [])
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }

  Future<Map<String, dynamic>> publicProfile(String username) async => _object(
      await request('GET', '/users/${Uri.encodeComponent(username)}', authenticated: false));

  @override
  void dispose() {
    _dio.close(force: true);
    super.dispose();
  }
}
