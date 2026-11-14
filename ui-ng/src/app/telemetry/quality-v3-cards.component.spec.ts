import { ComponentFixture, TestBed } from "@angular/core/testing";
import { QualityV3CardsComponent } from "./quality-v3-cards.component";

describe("QualityV3CardsComponent", () => {
  let fixture: ComponentFixture<QualityV3CardsComponent>;
  let component: QualityV3CardsComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [QualityV3CardsComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(QualityV3CardsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it("should create", () => {
    expect(component).toBeTruthy();
  });
});
