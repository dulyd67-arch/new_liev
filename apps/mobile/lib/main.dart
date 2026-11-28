import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'core/browser_bridge.dart';
import 'core/browser_config.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const LiveStarApp());
}

typedef BrowserBuilder = Widget Function(
  Key key,
  Map<String, Object> parameters,
  void Function(int) onCreated,
);

class LiveStarApp extends StatefulWidget {
  const LiveStarApp({super.key, this.browserBuilder});
  final BrowserBuilder? browserBuilder;

  @override
  State<LiveStarApp> createState() => _LiveStarAppState();
}

class _LiveStarAppState extends State<LiveStarApp> {
  Locale _locale = WidgetsBinding.instance.platformDispatcher.locale.languageCode ==
          'en'
      ? const Locale('en')
      : const Locale('ar');

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'LiveStar',
        debugShowCheckedModeBanner: false,
        locale: _locale,
        supportedLocales: const [Locale('ar'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        theme: ThemeData(
          brightness: Brightness.dark,
          scaffoldBackgroundColor: const Color(0xFF09070E),
          colorScheme: ColorScheme.fromSeed(
            seedColor: const Color(0xFFAA7FD4),
            brightness: Brightness.dark,
            surface: const Color(0xFF14101D),
          ),
          useMaterial3: true,
        ),
        home: LiveStarBrowser(
          locale: _locale,
          onLocale: (value) => setState(() => _locale = value),
          browserBuilder: widget.browserBuilder,
        ),
      );
}

class LiveStarBrowser extends StatefulWidget {
  const LiveStarBrowser({
    super.key,
    required this.locale,
    required this.onLocale,
    this.browserBuilder,
  });
  final Locale locale;
  final ValueChanged<Locale> onLocale;
  final BrowserBuilder? browserBuilder;

  @override
  State<LiveStarBrowser> createState() => _LiveStarBrowserState();
}

class _LiveStarBrowserState extends State<LiveStarBrowser> {
  final BrowserConfig _config = BrowserConfig.production();
  BrowserBridge? _bridge;
  Key _viewKey = UniqueKey();
  String _initialPath = '/';
  String? _currentUrl;
  String? _error;
  bool _loading = true;
  bool _canGoBack = false;
  bool _fullscreen = false;
  int _progress = 0;
  bool _confirming = false;

  String t(String ar, String en) => widget.locale.languageCode == 'ar' ? ar : en;
  String get _path => _config.pathOf(_currentUrl);
  bool get _hosting => _config.isHostingPath(_currentUrl);
  int get _selectedIndex {
    if (_path == '/go-live') return 1;
    if (_path == '/ai-host') return 2;
    if (_path == '/profile' || _path == '/settings' || _path.startsWith('/u/')) {
      return 3;
    }
    return 0;
  }

  @override
  void dispose() {
    _bridge?.dispose();
    super.dispose();
  }

  void _onState(Map<Object?, Object?> state) {
    if (!mounted) return;
    final rawUrl = state['url'];
    setState(() {
      if (rawUrl is String && _config.isTrusted(rawUrl)) _currentUrl = rawUrl;
      if (state['loading'] is bool) _loading = state['loading']! as bool;
      if (state['canGoBack'] is bool) _canGoBack = state['canGoBack']! as bool;
      if (state['fullscreen'] is bool) _fullscreen = state['fullscreen']! as bool;
      if (state['progress'] is int) {
        _progress = (state['progress']! as int).clamp(0, 100).toInt();
      }
      if (state.containsKey('error')) {
        final error = state['error'];
        _error = error is String ? error : null;
      }
    });
  }

  Future<void> _created(int viewId) async {
    _bridge?.dispose();
    final bridge = BrowserBridge(viewId, _onState);
    _bridge = bridge;
    try {
      _onState(await bridge.state());
    } on PlatformException {
      if (mounted) setState(() => _error = 'unavailable');
    }
  }

  Future<bool> _mayLeave() async {
    if (!_hosting) return true;
    if (_confirming) return false;
    _confirming = true;
    try {
      return await showDialog<bool>(
            context: context,
            builder: (context) => AlertDialog(
              title: Text(t('مغادرة الاستوديو؟', 'Leave the studio?')),
              content: Text(t(
                'مغادرة صفحة التشغيل قد تنهي البث إذا كان نشطًا.',
                'Leaving the hosting page may end an active broadcast.',
              )),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(context, false),
                  child: Text(t('البقاء', 'Stay')),
                ),
                FilledButton(
                  onPressed: () => Navigator.pop(context, true),
                  child: Text(t('مغادرة', 'Leave')),
                ),
              ],
            ),
          ) ??
          false;
    } finally {
      _confirming = false;
    }
  }

  Future<void> _navigate(String path) async {
    if (_bridge == null || _path == path || !await _mayLeave()) return;
    try {
      await _bridge!.navigate(path);
    } on PlatformException {
      if (mounted) setState(() => _error = 'unavailable');
    }
  }

  Future<void> _back() async {
    if (_fullscreen && _bridge != null) {
      try {
        await _bridge!.back();
      } on PlatformException {
        if (mounted) setState(() => _error = 'unavailable');
      }
      return;
    }
    if (!await _mayLeave()) return;
    try {
      if (_canGoBack && _bridge != null) {
        await _bridge!.back();
      } else {
        await SystemNavigator.pop();
      }
    } on PlatformException {
      if (mounted) setState(() => _error = 'unavailable');
    }
  }

  void _retry() {
    _bridge?.dispose();
    _bridge = null;
    setState(() {
      _initialPath = _path;
      _viewKey = UniqueKey();
      _error = null;
      _loading = true;
      _progress = 0;
    });
  }

  Future<void> _openBrowser() async {
    if (_bridge == null || !await _mayLeave()) return;
    try {
      await _bridge!.openBrowser();
    } on PlatformException {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(t('لم يتوفر متصفح لفتح الرابط.', 'No browser is available.'))),
        );
      }
    }
  }

  Future<void> _language() async {
    final language = widget.locale.languageCode == 'ar' ? 'en' : 'ar';
    widget.onLocale(Locale(language));
    try {
      await _bridge?.locale(language);
    } on PlatformException {
      // The site's own language control remains available while disconnected.
    }
  }

  void _about() {
    showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('LiveStar'),
        content: Text(t(
          'تطبيق متصل بمنصة LiveStar: المشاهدة والبث والهدايا DU والبروفايل والإدارة حسب صلاحيات الحساب. تحتاج الخدمات إلى الإنترنت. تشغيل المقدّمة الافتراضية تجريبي ويحتاج ذاكرة كافية وبقاء التطبيق ظاهرًا؛ لا يضمن التشغيل ٢٤ ساعة.',
          'Connected to LiveStar for watching, broadcasting, DU gifts, profiles and authorized administration. Internet access is required. The virtual host is experimental, needs sufficient memory and must remain in the foreground; 24-hour operation is not guaranteed.',
        )),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text(t('إغلاق', 'Close')),
          ),
        ],
      ),
    );
  }

  Widget _browser() {
    final parameters = <String, Object>{
      'baseUrl': _config.origin.toString(),
      'initialPath': _initialPath,
      'locale': widget.locale.languageCode,
    };
    if (widget.browserBuilder != null) {
      return widget.browserBuilder!(_viewKey, parameters, _created);
    }
    if (defaultTargetPlatform != TargetPlatform.android) {
      return Center(child: Text(t('هذه النسخة مخصّصة لأندرويد.', 'This build is for Android.')));
    }
    return AndroidView(
      key: _viewKey,
      viewType: 'livestar/browser',
      layoutDirection:
          widget.locale.languageCode == 'ar' ? TextDirection.rtl : TextDirection.ltr,
      creationParams: parameters,
      creationParamsCodec: const StandardMessageCodec(),
      onPlatformViewCreated: _created,
    );
  }

  @override
  Widget build(BuildContext context) => PopScope(
        canPop: false,
        onPopInvokedWithResult: (didPop, result) {
          if (!didPop) _back();
        },
        child: Scaffold(
          appBar: _fullscreen
              ? null
              : AppBar(
                  title: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.star_rounded, color: Color(0xFFE6BF7E)),
                      const SizedBox(width: 8),
                      Text('LiveStar', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
                    ],
                  ),
                  actions: [
                    IconButton(
                      tooltip: t('فتح في المتصفح', 'Open in browser'),
                      onPressed: _bridge == null ? null : _openBrowser,
                      icon: const Icon(Icons.open_in_browser_rounded),
                    ),
                    IconButton(
                      tooltip: t('تغيير اللغة', 'Change language'),
                      onPressed: _language,
                      icon: const Icon(Icons.translate_rounded),
                    ),
                    IconButton(
                      tooltip: t('عن التطبيق', 'About the app'),
                      onPressed: _about,
                      icon: const Icon(Icons.info_outline_rounded),
                    ),
                  ],
                ),
          body: SafeArea(
            top: _fullscreen,
            child: Stack(
              children: [
                Positioned.fill(child: _browser()),
                if (_loading && _error == null)
                  Positioned(
                    top: 0,
                    left: 0,
                    right: 0,
                    child: LinearProgressIndicator(
                      value: _progress == 0 ? null : _progress / 100,
                      color: const Color(0xFFE6BF7E),
                      minHeight: 3,
                    ),
                  ),
                if (_error != null)
                  Positioned.fill(
                    child: ColoredBox(
                      color: const Color(0xFF09070E),
                      child: Center(
                        child: SingleChildScrollView(
                          padding: const EdgeInsets.all(28),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const Icon(Icons.cloud_off_rounded, size: 48, color: Color(0xFFBA94E0)),
                              const SizedBox(height: 20),
                              Text(t('تعذّر فتح LiveStar', 'LiveStar could not open'), style: Theme.of(context).textTheme.titleLarge),
                              const SizedBox(height: 12),
                              Text(
                                _error == 'tls'
                                    ? t('تعذّر التحقق من الاتصال الآمن. تحقق من تاريخ الهاتف والاتصال ثم حاول مجددًا.', 'The secure connection could not be verified. Check your phone’s date and connection, then retry.')
                                    : t('تحقق من الإنترنت ثم أعد المحاولة. قد يستغرق تشغيل الاستضافة المجانية بعض الوقت.', 'Check your internet connection and retry. Free hosting can take a moment to wake up.'),
                                textAlign: TextAlign.center,
                              ),
                              const SizedBox(height: 22),
                              FilledButton.icon(
                                key: const Key('mobile-retry'),
                                onPressed: _retry,
                                icon: const Icon(Icons.refresh_rounded),
                                label: Text(t('إعادة المحاولة', 'Retry')),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          bottomNavigationBar: _fullscreen
              ? null
              : NavigationBar(
                  selectedIndex: _selectedIndex,
                  onDestinationSelected: (index) => _navigate(
                    const ['/', '/go-live', '/ai-host', '/profile'][index],
                  ),
                  destinations: [
                    NavigationDestination(icon: const Icon(Icons.explore_outlined), selectedIcon: const Icon(Icons.explore), label: t('اكتشف', 'Discover')),
                    NavigationDestination(icon: const Icon(Icons.videocam_outlined), selectedIcon: const Icon(Icons.videocam), label: t('ابدأ بثًا', 'Go live')),
                    NavigationDestination(icon: const Icon(Icons.auto_awesome_outlined), selectedIcon: const Icon(Icons.auto_awesome), label: t('ليان', 'Layan')),
                    NavigationDestination(icon: const Icon(Icons.person_outline_rounded), selectedIcon: const Icon(Icons.person), label: t('حسابي', 'Profile')),
                  ],
                ),
        ),
      );
}
