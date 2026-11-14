import { ComponentFixture, TestBed } from "@angular/core/testing";
import { QaV3StudioComponent } from "./qa-v3-studio.component";
import { provideHttpClient } from "@angular/common/http";
import { provideHttpClientTesting } from "@angular/common/http/testing";
import { AccessService } from "../services/access.service";
import { SnackbarService } from "../services/snackbar.service";

describe("QaV3StudioComponent", () => {
  let fixture: ComponentFixture<QaV3StudioComponent>;
  let component: QaV3StudioComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [QaV3StudioComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AccessService, useValue: { can: () => true } },
        { provide: SnackbarService, useValue: { show: () => {} } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(QaV3StudioComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it("should create", () => {
    expect(component).toBeTruthy();
  });
});
