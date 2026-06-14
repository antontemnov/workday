import { Component, ElementRef, EventEmitter, HostListener, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SensitivityLevel } from '../../../../models/workday.models';

export interface ModeOption {
  readonly key: SensitivityLevel;
  readonly label: string;
  readonly description: string;
  readonly title?: string;
}

/**
 * Custom sensitivity (mode) picker for the session card's second row.
 * Closed control speaks the same chip language as the time/git chips — gently
 * tinted by the active mode, a divider, and a chevron toggle. The open menu
 * lists the modes with coloured labels + a short idle-leash hint; only Nonstop
 * is filled (its drifting gradient). Emits the chosen level.
 *
 * Holds only open/closed state; closes on outside click or Escape.
 */
@Component({
  selector: 'app-mode-dropdown',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './mode-dropdown.component.html',
  styleUrl: './mode-dropdown.component.scss',
})
export class ModeDropdownComponent {
  @Input({ required: true }) options: readonly ModeOption[] = [];
  @Input({ required: true }) value!: SensitivityLevel;
  @Input() disabled = false;

  @Output() selected = new EventEmitter<SensitivityLevel>();
  // Lets the card lift its z-index while the menu overflows its bounds.
  @Output() openChange = new EventEmitter<boolean>();

  public open = false;

  public constructor(private readonly host: ElementRef<HTMLElement>) {}

  public get current(): ModeOption | undefined {
    return this.options.find(o => o.key === this.value);
  }

  // key → css modifier matching the sensitivity colour system (m-low, m-normal…).
  public modeClass(key: SensitivityLevel): string {
    return 'm-' + key;
  }

  public toggle(): void {
    if (this.disabled) return;
    this.setOpen(!this.open);
  }

  public choose(key: SensitivityLevel): void {
    this.setOpen(false);
    if (key !== this.value) this.selected.emit(key);
  }

  @HostListener('document:click', ['$event'])
  public onDocumentClick(event: MouseEvent): void {
    if (this.open && !this.host.nativeElement.contains(event.target as Node)) {
      this.setOpen(false);
    }
  }

  @HostListener('document:keydown.escape')
  public onEscape(): void {
    if (this.open) this.setOpen(false);
  }

  private setOpen(next: boolean): void {
    if (this.open === next) return;
    this.open = next;
    this.openChange.emit(next);
  }
}
