import styles from './wallet.module.css';

/** The DU mark is decorative; surrounding text supplies the currency label. */
export function DuCoin({ large = false }: { large?: boolean }) {
  return <span className={`${styles.coin} ${large ? styles.coinLarge : ''}`} aria-hidden="true"><span>DU</span></span>;
}
