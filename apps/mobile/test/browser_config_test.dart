import 'package:flutter_test/flutter_test.dart';
import 'package:livestar/core/browser_config.dart';

void main() {
  test('only a credential-free public HTTPS origin can configure the app', () {
    for (final value in [
      'http://livestar-live-nitq.onrender.com',
      'https://user:pass@livestar-live-nitq.onrender.com',
      'https://livestar-live-nitq.onrender.com/other',
      'https://livestar-live-nitq.onrender.com?next=https://example.org',
      'https://livestar-live-nitq.onrender.com#fragment',
      'https://livestar-live-nitq.onrender.com:8443',
      'javascript:alert(1)',
      'https://localhost',
      'https://127.0.0.1',
      'https://router.local',
    ]) {
      expect(() => BrowserConfig(value), throwsArgumentError, reason: value);
    }
  });

  test('navigation never trusts lookalikes or credentials', () {
    final config = BrowserConfig.production();
    expect(config.isTrusted('https://livestar-live-nitq.onrender.com/profile'), isTrue);
    expect(config.isTrusted('https://LIVESTAR-LIVE-NITQ.ONRENDER.COM:443/ai-host'), isTrue);
    for (final value in [
      'https://livestar-live-nitq.onrender.com.evil.example/profile',
      'https://livestar-live-nitq.onrender.com@evil.example',
      'https://user@livestar-live-nitq.onrender.com',
      'http://livestar-live-nitq.onrender.com',
      'https://livestar-live-nitq.onrender.com:444',
      'file:///data/data/com.livestar.live/shared_prefs',
      'content://com.example/private',
      'intent://livestar-live-nitq.onrender.com',
      'javascript:alert(1)',
    ]) {
      expect(config.isTrusted(value), isFalse, reason: value);
    }
  });

  test('only actual hosting routes prompt before navigation', () {
    final config = BrowserConfig.production();
    expect(config.isHostingPath(config.origin.resolve('/go-live').toString()), isTrue);
    expect(config.isHostingPath(config.origin.resolve('/ai-host').toString()), isTrue);
    expect(config.isHostingPath(config.origin.resolve('/profile').toString()), isFalse);
    expect(config.isHostingPath(config.origin.resolve('/live/example').toString()), isFalse);
    expect(config.isHostingPath('https://evil.example/ai-host'), isFalse);
  });
}
