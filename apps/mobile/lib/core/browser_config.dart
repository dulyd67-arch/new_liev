/// This is an origin, not an editable URL supplied by web content.
class BrowserConfig {
  BrowserConfig(String value) : origin = _parse(value);

  factory BrowserConfig.production() => BrowserConfig(
        const String.fromEnvironment(
          'LIVESTAR_WEB_URL',
          defaultValue: 'https://livestar-live-nitq.onrender.com',
        ),
      );

  final Uri origin;

  static Uri _parse(String value) {
    final uri = Uri.tryParse(value);
    if (uri == null ||
        uri.scheme != 'https' ||
        uri.host.isEmpty ||
        !_publicDnsName(uri.host) ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment ||
        (uri.path.isNotEmpty && uri.path != '/') ||
        (uri.hasPort && uri.port != 443) ||
        RegExp(r'[\x00-\x20\\]').hasMatch(value)) {
      throw ArgumentError('LIVESTAR_WEB_URL must be a public HTTPS origin.');
    }
    return uri.replace(path: '');
  }

  static bool _publicDnsName(String value) {
    final host = value.toLowerCase();
    const reserved = ['localhost', 'local', 'internal', 'invalid', 'test', 'home.arpa'];
    if (host.length > 253 ||
        !host.contains('.') ||
        host.endsWith('.') ||
        reserved.any((suffix) => host == suffix || host.endsWith('.$suffix'))) {
      return false;
    }
    final labels = host.split('.');
    final pattern = RegExp(r'^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$');
    return labels.every(pattern.hasMatch) && RegExp('[a-z]').hasMatch(labels.last);
  }

  bool isTrusted(String? value) {
    if (value == null) return false;
    final uri = Uri.tryParse(value);
    return uri != null &&
        uri.scheme == 'https' &&
        uri.host.toLowerCase() == origin.host.toLowerCase() &&
        uri.port == origin.port &&
        uri.userInfo.isEmpty &&
        !RegExp(r'[\x00-\x20\\]').hasMatch(value);
  }

  String pathOf(String? value) =>
      isTrusted(value) ? Uri.parse(value!).path : '/';

  bool isHostingPath(String? value) {
    final path = pathOf(value);
    return path == '/go-live' || path == '/ai-host';
  }
}
