import 'package:flutter/material.dart';

import '../l10n/strings.dart';

/// An honest unavailable state until a service is enabled for the account.
/// No sample balances, viewers, orders, or payment actions are displayed.
class FeatureScreen extends StatelessWidget {
  const FeatureScreen({
    super.key,
    required this.strings,
    required this.title,
    required this.icon,
    this.description,
  });

  final AppStrings strings;
  final String title;
  final IconData icon;
  final String? description;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    const gold = Color(0xFFE6BC70);

    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 28,
                  vertical: 36,
                ),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(28),
                  border: Border.all(color: const Color(0xFF332644)),
                  gradient: const LinearGradient(
                    begin: AlignmentDirectional.topStart,
                    end: AlignmentDirectional.bottomEnd,
                    colors: [Color(0xFF21142F), Color(0xFF100D17)],
                  ),
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 80,
                      height: 80,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: const Color(0xFF2F2233),
                        border: Border.all(color: const Color(0xFF6A4D49)),
                      ),
                      child: Icon(icon, size: 36, color: gold),
                    ),
                    const SizedBox(height: 28),
                    Semantics(
                      header: true,
                      child: Text(
                        strings['notAvailable'],
                        textAlign: TextAlign.center,
                        style: theme.textTheme.headlineSmall?.copyWith(
                          fontWeight: FontWeight.w700,
                          color: Colors.white,
                        ),
                      ),
                    ),
                    const SizedBox(height: 14),
                    Text(
                      description ?? strings['notAvailableDescription'],
                      textAlign: TextAlign.center,
                      style: theme.textTheme.bodyLarge?.copyWith(
                        height: 1.7,
                        color: const Color(0xFFC8C0D2),
                      ),
                    ),
                    const SizedBox(height: 30),
                    OutlinedButton.icon(
                      onPressed: Navigator.of(context).canPop()
                          ? () => Navigator.of(context).maybePop()
                          : null,
                      icon: const Icon(Icons.arrow_back_rounded),
                      label: Text(strings['back']),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
