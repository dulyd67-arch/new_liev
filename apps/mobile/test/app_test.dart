import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:livestar/main.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('livestar/browser/7');
  Map<String, Object?> state = {};
  final calls = <MethodCall>[];

  setUp(() {
    calls.clear();
    state = {
      'url': 'https://livestar-live-nitq.onrender.com/',
      'loading': false,
      'progress': 100,
      'canGoBack': false,
      'fullscreen': false,
      'error': null,
    };
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      return call.method == 'state' ? state : null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  Widget app() => LiveStarApp(
        browserBuilder: (key, parameters, onCreated) =>
            _FakeBrowser(key: key, onCreated: onCreated),
      );

  testWidgets('real shell uses Arabic RTL and routes to the virtual host', (tester) async {
    tester.binding.platformDispatcher.localeTestValue = const Locale('ar');
    addTearDown(tester.binding.platformDispatcher.clearLocaleTestValue);
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.text('LiveStar'), findsOneWidget);
    expect(Directionality.of(tester.element(find.text('اكتشف'))), TextDirection.rtl);
    await tester.tap(find.text('ليان'));
    await tester.pumpAndSettle();
    expect(calls.any((call) => call.method == 'navigate' && (call.arguments as Map)['path'] == '/ai-host'), isTrue);
  });

  testWidgets('network failure offers a retry and recreates the browser', (tester) async {
    state['error'] = 'network';
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('mobile-retry')), findsOneWidget);
    final firstCount = calls.where((call) => call.method == 'state').length;
    state['error'] = null;
    await tester.tap(find.byKey(const Key('mobile-retry')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('mobile-retry')), findsNothing);
    expect(calls.where((call) => call.method == 'state').length, greaterThan(firstCount));
  });

  testWidgets('leaving a hosting page requires an explicit user decision', (tester) async {
    tester.binding.platformDispatcher.localeTestValue = const Locale('en');
    addTearDown(tester.binding.platformDispatcher.clearLocaleTestValue);
    state['url'] = 'https://livestar-live-nitq.onrender.com/ai-host';
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    await tester.tap(find.text('Discover'));
    await tester.pumpAndSettle();
    expect(find.text('Leave the studio?'), findsOneWidget);
    expect(calls.where((call) => call.method == 'navigate'), isEmpty);
    await tester.tap(find.text('Stay'));
    await tester.pumpAndSettle();
    expect(calls.where((call) => call.method == 'navigate'), isEmpty);
    await tester.tap(find.text('Discover'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Leave'));
    await tester.pumpAndSettle();
    expect(calls.any((call) => call.method == 'navigate' && (call.arguments as Map)['path'] == '/'), isTrue);
  });
}

class _FakeBrowser extends StatefulWidget {
  const _FakeBrowser({super.key, required this.onCreated});
  final ValueChanged<int> onCreated;

  @override
  State<_FakeBrowser> createState() => _FakeBrowserState();
}

class _FakeBrowserState extends State<_FakeBrowser> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.onCreated(7);
    });
  }

  @override
  Widget build(BuildContext context) => const SizedBox.expand();
}
